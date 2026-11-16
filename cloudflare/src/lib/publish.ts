import { ADAPTERS } from "../platforms";
import { PublishError, type PublishFailureKind, type PublishMedia, type PublishPost } from "../platforms/types";
import type { ClaimedPost } from "./delivery";
import { saveAccountTokens } from "./oauth-refresh";
import { R2BudgetExceededError, reserveR2Budget } from "./r2-budget";

type PublishRow = {
  id: number;
  scheduled_for: number;
  content: string;
  platform_options_json: string;
  social_account_id: number;
  platform: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: number | null;
  external_account_id: string | null;
  metadata_json: string;
};

export type PublishOutcome =
  | { kind: "published"; platformPostId: string }
  | { kind: "no_adapter"; platform: string }
  | { kind: "failed"; failure: PublishFailureKind; message: string; retryAfterSeconds?: number };

/**
 * Marks that the platform is about to be contacted for this lease. Returns
 * false when it was already marked, i.e. this step is a re-run of one that may
 * have contacted the platform; the caller must then not publish again.
 */
export async function markPublishStarted(database: D1Database, claim: ClaimedPost): Promise<boolean> {
  const row = await database
    .prepare(
      `UPDATE posts SET posting_started_at = unixepoch()
        WHERE id = ? AND status = 'posting' AND workflow_instance_id = ?
          AND posting_lease_token = ? AND posting_started_at IS NULL
        RETURNING id`,
    )
    .bind(claim.postId, claim.workflowInstanceId, claim.leaseToken)
    .first();
  return row !== null;
}

/** Runs the platform adapter for a claimed post. Never throws for platform outcomes. */
export async function publishClaimedPost(env: Env, claim: ClaimedPost): Promise<PublishOutcome> {
  const row = await env.DB
    .prepare(
      `SELECT posts.id, posts.scheduled_for, posts.content, posts.platform_options_json, posts.social_account_id,
              social_accounts.platform, social_accounts.access_token, social_accounts.refresh_token,
              social_accounts.token_expires_at, social_accounts.external_account_id,
              social_accounts.metadata_json
         FROM posts JOIN social_accounts ON social_accounts.id = posts.social_account_id
        WHERE posts.id = ?`,
    )
    .bind(claim.postId)
    .first<PublishRow>();
  if (!row) return { kind: "failed", failure: "rejected", message: "The post or its account no longer exists." };

  const adapter = ADAPTERS[row.platform];
  if (!adapter) return { kind: "no_adapter", platform: row.platform };
  if (!row.access_token) return { kind: "failed", failure: "auth", message: "The account has no stored credential; reconnect it." };

  const { results: files } = await env.DB
    .prepare(
      `SELECT post_media.alt_text, media_files.r2_key, media_files.content_type
         FROM post_media JOIN media_files ON media_files.id = post_media.media_file_id
        WHERE post_media.post_id = ? ORDER BY post_media.position, post_media.id`,
    )
    .bind(claim.postId)
    .all<{ alt_text: string | null; r2_key: string; content_type: string }>();

  const media: PublishMedia[] = files.map((file) => ({
    path: file.r2_key.replace(/^media\//, ""),
    contentType: file.content_type,
    altText: file.alt_text,
    read: async () => {
      try {
        await reserveR2Budget(env.DB, env.R2_BUDGET, { classBOperations: 1 });
      } catch (error) {
        if (error instanceof R2BudgetExceededError) throw new PublishError("budget", "Media reads are paused by the R2 budget guard.");
        throw error;
      }
      const object = await env.MEDIA.get(file.r2_key);
      if (!object) throw new PublishError("rejected", "An attached media file is missing from storage.");
      return object.arrayBuffer();
    },
  }));

  const post: PublishPost = {
    postId: row.id,
    idempotencyKey: `postfalcon-${row.id}-${row.scheduled_for}`,
    content: row.content,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    tokenExpiresAt: row.token_expires_at,
    saveTokens: (accessToken, refreshToken, expiresAt) => saveAccountTokens(env.DB, row.social_account_id, accessToken, refreshToken, expiresAt),
    env,
    externalAccountId: row.external_account_id,
    metadata: JSON.parse(row.metadata_json) as Record<string, any>,
    platformOptions: (JSON.parse(row.platform_options_json) as Record<string, any>)[row.platform] ?? {},
    media,
  };

  try {
    return { kind: "published", platformPostId: await adapter.publish(post) };
  } catch (error) {
    if (error instanceof PublishError) {
      return { kind: "failed", failure: error.kind, message: error.message.slice(0, 500), retryAfterSeconds: error.retryAfterSeconds };
    }
    // An unclassified error could have happened after the platform accepted
    // the post, so it is treated as ambiguous rather than retried.
    return { kind: "failed", failure: "ambiguous", message: `Unexpected publishing error: ${String(error).slice(0, 400)}` };
  }
}

type Settlement = {
  outcome: "published" | "failed" | "skipped";
  detail: string;
  set: string;
  params: unknown[];
};

/**
 * Applies the end state of a claimed delivery and its audit row in one
 * transaction, only while the caller still owns the lease. Ownership comes from
 * RETURNING, not meta.changes (D1 also counts trigger writes).
 */
async function settle(database: D1Database, claim: ClaimedPost, result: Settlement): Promise<boolean> {
  const owned = `id = ? AND status = 'posting' AND workflow_instance_id = ? AND posting_lease_token = ?`;
  const [, updated] = await database.batch<{ id: number }>([
    database
      .prepare(
        `INSERT INTO post_delivery_attempts (post_id, workflow_instance_id, lease_token, outcome, detail)
         SELECT id, workflow_instance_id, posting_lease_token, ?, ? FROM posts WHERE ${owned}`,
      )
      .bind(result.outcome, result.detail, claim.postId, claim.workflowInstanceId, claim.leaseToken),
    database
      .prepare(
        `UPDATE posts SET ${result.set}, posting_lease_token = NULL, posting_lease_expires_at = NULL, updated_at = unixepoch()
          WHERE ${owned} RETURNING id`,
      )
      .bind(...result.params, claim.postId, claim.workflowInstanceId, claim.leaseToken),
  ]);
  return updated.results.length === 1;
}

export async function markPublished(database: D1Database, claim: ClaimedPost, platformPostId: string): Promise<void> {
  const settled = await settle(database, claim, {
    outcome: "published",
    detail: `published as ${platformPostId}`,
    set: "status = 'posted', posted_at = unixepoch(), platform_post_id = ?, error_message = NULL, review_reason = NULL",
    params: [platformPostId],
  });
  if (!settled) {
    // The lease expired while the platform call was running and the sweep sent
    // the post to review. The post really is published, so record that.
    await database.batch([
      database
        .prepare(
          `INSERT INTO post_delivery_attempts (post_id, workflow_instance_id, lease_token, outcome, detail)
           VALUES (?, ?, ?, 'published', ?)`,
        )
        .bind(claim.postId, claim.workflowInstanceId, claim.leaseToken, `published as ${platformPostId} after the lease expired`),
      database
        .prepare(
          `UPDATE posts SET status = 'posted', posted_at = unixepoch(), platform_post_id = ?, error_message = NULL,
                  review_reason = NULL, updated_at = unixepoch()
            WHERE id = ? AND status = 'review_required' AND workflow_instance_id = ?`,
        )
        .bind(platformPostId, claim.postId, claim.workflowInstanceId),
    ]);
  }
  await database
    .prepare("UPDATE social_accounts SET needs_reconnect_at = NULL, reconnect_reason = NULL WHERE id = (SELECT social_account_id FROM posts WHERE id = ?) AND needs_reconnect_at IS NOT NULL")
    .bind(claim.postId)
    .run();
}

/** Definite failure: nothing was posted (or the platform refused it). */
export async function markFailed(database: D1Database, claim: ClaimedPost, message: string, needsReconnect: boolean): Promise<{ newlyFlaggedAccountId: number | null }> {
  const settled = await settle(database, claim, {
    outcome: "failed",
    detail: message,
    set: "status = 'failed', error_message = ?",
    params: [message],
  });
  if (!settled) throw new Error(`Lost delivery lease for post ${claim.postId}`);
  if (needsReconnect) {
    // RETURNING tells whether this call is the one that flagged the account, so
    // the owner is emailed once rather than for every failed post.
    const flagged = await database
      .prepare(
        `UPDATE social_accounts SET needs_reconnect_at = unixepoch(), reconnect_reason = ?
          WHERE id = (SELECT social_account_id FROM posts WHERE id = ?) AND needs_reconnect_at IS NULL RETURNING id`,
      )
      .bind(message.slice(0, 500), claim.postId)
      .first<{ id: number }>();
    return { newlyFlaggedAccountId: flagged?.id ?? null };
  }
  return { newlyFlaggedAccountId: null };
}

/**
 * Nothing was posted and the media budget is spent: park the post. It resumes
 * (back to scheduled, new schedule revision) when `resumeBudgetHolds` finds headroom.
 */
export async function markBudgetHold(database: D1Database, claim: ClaimedPost, message: string): Promise<void> {
  const settled = await settle(database, claim, {
    outcome: "skipped",
    detail: `held: ${message}`,
    set: "status = 'budget_hold', review_reason = ?, error_message = ?",
    params: [message, message],
  });
  if (!settled) throw new Error(`Lost delivery lease for post ${claim.postId}`);
}

/**
 * Releases held posts once this month's Class B budget has room again (a new
 * month resets it, since the counters roll over with the period key).
 */
export async function resumeBudgetHolds(database: D1Database, maxClassBOperations: number, now = new Date()): Promise<number> {
  const state = await database
    .prepare("SELECT class_b_operations, period_key FROM r2_budget_state WHERE singleton = 1")
    .first<{ class_b_operations: number; period_key: string }>();
  if (!state) return 0;
  const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const used = state.period_key === thisMonth ? state.class_b_operations : 0;
  // Keep headroom for the reads each held post needs; one post at a time otherwise.
  if (used >= maxClassBOperations - 20) return 0;
  const { results } = await database
    .prepare(
      `UPDATE posts SET status = 'scheduled', schedule_revision = schedule_revision + 1, workflow_instance_id = NULL,
              review_reason = NULL, error_message = NULL, updated_at = unixepoch()
        WHERE status = 'budget_hold' RETURNING id`,
    )
    .all<{ id: number }>();
  return results.length;
}

/** Nothing was posted and the platform asked us to wait: back to scheduled for another claim. */
export async function requeueForRetry(database: D1Database, claim: ClaimedPost, message: string): Promise<void> {
  const settled = await settle(database, claim, {
    outcome: "skipped",
    detail: `will retry: ${message}`,
    set: "status = 'scheduled', error_message = ?",
    params: [message],
  });
  if (!settled) throw new Error(`Lost delivery lease for post ${claim.postId}`);
}
