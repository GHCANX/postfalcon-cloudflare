import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import {
  claimPostForDelivery,
  markReviewRequired,
  type DeliveryParams,
  parseDeliveryParams,
  workflowInstanceId,
} from "../lib/delivery";
import { scheduleNextOccurrence } from "../lib/recurrence";
import { markFailed, markPublished, markPublishStarted, publishClaimedPost, requeueForRetry } from "../lib/publish";

const MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_SECONDS = [60, 300];

type Result =
  | { outcome: "skipped" | "published" | "failed" | "review_required" }
  | { outcome: "retry"; seconds: number };

// Keep the instance id and claim tied to the schedule revision (see delivery.ts).
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
          case "transient":
            if (attempt < MAX_ATTEMPTS) {
              await requeueForRetry(this.env.DB, claim, published.message);
              return { outcome: "retry", seconds: published.retryAfterSeconds ?? DEFAULT_BACKOFF_SECONDS[attempt - 1] ?? 300 };
            }
            await markFailed(this.env.DB, claim, `${published.message} (gave up after ${MAX_ATTEMPTS} attempts; nothing was posted)`, false);
            return { outcome: "failed" };
          case "auth":
            await markFailed(this.env.DB, claim, published.message, true);
            return { outcome: "failed" };
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
      if (result.outcome !== "retry") return result;
      await step.sleep(`back off ${attempt}`, result.seconds);
    }
    return { outcome: "failed" as const };
  }
}
