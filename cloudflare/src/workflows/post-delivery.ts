import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import {
  claimPostForDelivery,
  markReviewRequired,
  type DeliveryParams,
  parseDeliveryParams,
  workflowInstanceId,
} from "../lib/delivery";
import { adminRecipients, mailConfigured, sendMail } from "../lib/mailer";
import { deliverWebhook, type WebhookEvent, webhookIdsFor } from "../lib/webhooks";
import { refreshOne } from "../lib/metrics";
import { scheduleNextOccurrence } from "../lib/recurrence";
import { markBudgetHold, markFailed, markPublished, markPublishStarted, publishClaimedPost, requeueForRetry } from "../lib/publish";

const MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_SECONDS = [60, 300];

type Result =
  | { outcome: "skipped" | "published" | "failed" | "review_required"; reconnectAccountId?: number }
  | { outcome: "retry"; seconds: number };

// Keep the instance id and claim tied to the schedule revision (see delivery.ts).
const WEBHOOK_EVENT_FOR: Record<string, WebhookEvent> = {
  published: "post.published",
  failed: "post.failed",
  review_required: "post.review_required",
};

export class ScheduledPostDelivery extends WorkflowEntrypoint<Env, DeliveryParams> {
  async run(event: WorkflowEvent<DeliveryParams>, step: WorkflowStep) {
    // Input is validated at the platform boundary: an instance created from the
    // CLI delivers a JSON string, and some runtime versions expose it as `params`.
    const params = parseDeliveryParams(
      (event as WorkflowEvent<DeliveryParams> & { params?: unknown }).params ?? event.payload,
    );
    const instanceId = workflowInstanceId(params);
    const dueAt = params.scheduledFor * 1000;
    if (dueAt > Date.now()) {
      await step.sleepUntil("wait until scheduled delivery", dueAt);
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const claim = await step.do(`claim ${attempt}`, async () => claimPostForDelivery(this.env.DB, params, instanceId));
      if (!claim) return { outcome: "skipped" as const };

      // Platform outcomes are returned, never thrown, and the step is not
      // retried by the engine: an interrupted publish must not run twice.
      const result = await step.do(`publish ${attempt}`, { retries: { limit: 0, delay: 1 } }, async (): Promise<Result> => {
        if (!(await markPublishStarted(this.env.DB, claim))) {
          await markReviewRequired(
            this.env.DB,
            claim,
            "The publish step was interrupted after it may have contacted the platform; check the platform before retrying.",
          );
          return { outcome: "review_required" };
        }

        const published = await publishClaimedPost(this.env, claim);
        if (published.kind === "published") {
          await markPublished(this.env.DB, claim, published.platformPostId);
          return { outcome: "published" };
        }
        if (published.kind === "no_adapter") {
          await markReviewRequired(
            this.env.DB,
            claim,
            `No Cloudflare adapter exists for ${published.platform}; manual review is required before retrying.`,
          );
          return { outcome: "review_required" };
        }
        switch (published.failure) {
          case "ambiguous":
            await markReviewRequired(this.env.DB, claim, published.message);
            return { outcome: "review_required" };
          case "budget":
            await markBudgetHold(this.env.DB, claim, published.message);
            return { outcome: "skipped" };
          case "transient":
            if (attempt < MAX_ATTEMPTS) {
              await requeueForRetry(this.env.DB, claim, published.message);
              return { outcome: "retry", seconds: published.retryAfterSeconds ?? DEFAULT_BACKOFF_SECONDS[attempt - 1] ?? 300 };
            }
            await markFailed(this.env.DB, claim, `${published.message} (gave up after ${MAX_ATTEMPTS} attempts; nothing was posted)`, false);
            return { outcome: "failed" };
          case "auth":
            {
              const { newlyFlaggedAccountId } = await markFailed(this.env.DB, claim, published.message, true);
              return { outcome: "failed", ...(newlyFlaggedAccountId ? { reconnectAccountId: newlyFlaggedAccountId } : {}) };
            }
          default:
            await markFailed(this.env.DB, claim, published.message, false);
            return { outcome: "failed" };
        }
      });

      if (result.outcome === "published") {
        // Idempotent, so the engine may retry it; a failure here must not
        // change the (already recorded) outcome of this post.
        await step.do("queue next occurrence", async () => scheduleNextOccurrence(this.env.DB, params.postId)).catch((error: unknown) =>
          console.error(JSON.stringify({ event: "next_occurrence_failed", postId: params.postId, error: String(error) })),
        );
      }
      if (result.outcome === "published") {
        // First metrics read right away, so Analytics shows the new post's counts
        // before the next scheduled refresh. Best effort.
        await step
          .do("initial metrics", async () => {
            const post = await this.env.DB
              .prepare(
                `SELECT posts.id, social_accounts.platform, posts.platform_post_id, social_accounts.access_token,
                        social_accounts.refresh_token, social_accounts.token_expires_at, posts.social_account_id,
                        social_accounts.external_account_id, social_accounts.metadata_json
                   FROM posts JOIN social_accounts ON social_accounts.id = posts.social_account_id WHERE posts.id = ?`,
              )
              .bind(params.postId)
              
              .first<{ id: number; platform: string; platform_post_id: string | null; access_token: string | null; refresh_token: string | null; token_expires_at: number | null; social_account_id: number; external_account_id: string | null; metadata_json: string }>();
            if (!post?.platform_post_id) return false;
            return refreshOne(this.env, { ...post, platform_post_id: post.platform_post_id });
          })
          .catch(() => undefined);
      }
      if (result.outcome === "review_required") {
        await this.alert(step, params.postId, { kind: "review" });
      } else if (result.outcome === "failed" && result.reconnectAccountId) {
        await this.alert(step, params.postId, { kind: "reconnect", accountId: result.reconnectAccountId });
      }
      const event = WEBHOOK_EVENT_FOR[result.outcome];
      if (event) await this.notify(step, params, event);
      if (result.outcome !== "retry") return result;
      await step.sleep(`back off ${attempt}`, result.seconds);
    }
    return { outcome: "failed" as const };
  }

  /**
   * Tells the owner's webhooks about the outcome, one durable step per
   * endpoint, retried with backoff for network errors, 5xx and 429. Never
   * affects the post: failures are only recorded in webhook_deliveries.
   */
  private async notify(step: WorkflowStep, params: DeliveryParams, event: WebhookEvent): Promise<void> {
    try {
      const target = await step.do(`webhooks ${event}`, async () => {
        const post = await this.env.DB
          .prepare(
            `SELECT posts.user_id, posts.scheduled_for, posts.platform_post_id, posts.error_message, posts.review_reason,
                    social_accounts.platform
               FROM posts JOIN social_accounts ON social_accounts.id = posts.social_account_id WHERE posts.id = ?`,
          )
          .bind(params.postId)
          .first<{ user_id: number; scheduled_for: number | null; platform_post_id: string | null; error_message: string | null; review_reason: string | null; platform: string }>();
        if (!post) return null;
        const data =
          event === "post.published"
            ? { post_id: params.postId, platform: post.platform, platform_post_id: post.platform_post_id, scheduled_for: post.scheduled_for === null ? null : new Date(post.scheduled_for * 1000).toISOString() }
            : { post_id: params.postId, platform: post.platform, error: post.error_message ?? post.review_reason };
        return { ids: await webhookIdsFor(this.env.DB, post.user_id, event), data };
      });
      if (!target) return;
      const deliveryKey = `${workflowInstanceId(params)}:${event}`;
      for (const id of target.ids) {
        let attempt = 0;
        await step
          .do(
            `deliver webhook ${id} ${event}`,
            { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" } },
            async () => {
              attempt += 1;
              const result = await deliverWebhook(this.env.DB, id, event, target.data, deliveryKey, attempt);
              // 4xx other than 429 is a definite refusal; retrying will not help.
              const retryable = result.status === null || result.status >= 500 || result.status === 429;
              if (!result.delivered && retryable) throw new Error(`webhook ${id} answered ${result.status ?? "no response"}`);
              return result.status;
            },
          )
          .catch(() => undefined);
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "webhook_notify_failed", postId: params.postId, error: String(error) }));
    }
  }

  /**
   * Emails the owner(s) about something only a person can fix. Retried a couple
   * of times for Mailgun/network errors; a send that still fails is recorded in
   * email_deliveries and never changes the post.
   */
  private async alert(step: WorkflowStep, postId: number, what: { kind: "review" } | { kind: "reconnect"; accountId: number }): Promise<void> {
    if (!mailConfigured(this.env)) return;
    try {
      await step.do(`email alert ${what.kind}`, { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" } }, async () => {
        const post = await this.env.DB
          .prepare(
            `SELECT posts.content, posts.review_reason, social_accounts.platform, social_accounts.display_name, social_accounts.reconnect_reason
               FROM posts JOIN social_accounts ON social_accounts.id = posts.social_account_id WHERE posts.id = ?`,
          )
          .bind(postId)
          .first<{ content: string; review_reason: string | null; platform: string; display_name: string; reconnect_reason: string | null }>();
        if (!post) return "gone";
        const preview = post.content.length > 120 ? `${post.content.slice(0, 120)}...` : post.content;
        const message =
          what.kind === "review"
            ? {
                category: "post_review_required",
                subject: `Post #${postId} to ${post.display_name} needs review`,
                text: `Post #${postId} to ${post.display_name} (${post.platform}) may or may not have been published, so it was not retried.\n\nReason: ${post.review_reason ?? "unknown"}\n\nPost: ${preview}\n\nCheck ${post.platform}, then resolve it with POST /api/admin/posts/${postId}/resolve (retry, mark_posted or mark_failed).`,
              }
            : {
                category: "reconnect_account",
                subject: `Reconnect ${post.display_name} (${post.platform}) to keep posting`,
                text: `${post.platform} stopped accepting Postfalcon's access to ${post.display_name}. Scheduled posts to it will fail until you reconnect it.\n\nDetail: ${post.reconnect_reason ?? "unknown"}`,
              };
        let failure: string | null = null;
        for (const admin of await adminRecipients(this.env.DB)) {
          const result = await sendMail(this.env, { to: admin.email, userId: admin.id, ...message });
          if (result.status === "failed") failure = result.error ?? "send failed";
        }
        if (failure) throw new Error(failure);
        return "sent";
      });
    } catch (error) {
      console.error(JSON.stringify({ event: "alert_email_failed", postId, error: String(error).slice(0, 300) }));
    }
  }
}
