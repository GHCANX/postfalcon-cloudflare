import { ADAPTERS } from "../platforms";
import { saveAccountTokens } from "./oauth-refresh";

/** Calls per run stay well under the Free plan's 50 subrequests per invocation. */
const BATCH = 20;
const WINDOW_SECONDS = 30 * 24 * 60 * 60;

type Row = {
  id: number;
  platform: string;
  platform_post_id: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: number | null;
  external_account_id: string | null;
  metadata_json: string;
  social_account_id: number;
};

/**
 * Refreshes engagement counts for the posts whose numbers are oldest, among
 * posts published in the last 30 days. Platforms without a metrics adapter are
 * skipped. One failing post (rate limit, deleted post) never stops the run;
 * an auth failure flags the account for reconnecting.
 */
export async function refreshPostMetrics(
  env: Env,
  limit = BATCH,
  now = Math.floor(Date.now() / 1000),
): Promise<{ checked: number; refreshed: number }> {
  const database = env.DB;
  const withMetrics = Object.keys(ADAPTERS).filter((platform) => ADAPTERS[platform]!.fetchMetrics);
  if (withMetrics.length === 0) return { checked: 0, refreshed: 0 };

  const { results } = await database
    .prepare(
      `SELECT posts.id, social_accounts.platform, posts.platform_post_id, social_accounts.access_token,
              social_accounts.refresh_token, social_accounts.token_expires_at, social_accounts.external_account_id, social_accounts.metadata_json, posts.social_account_id
         FROM posts JOIN social_accounts ON social_accounts.id = posts.social_account_id
        WHERE posts.status = 'posted' AND posts.platform_post_id IS NOT NULL AND posts.posted_at >= ?
          AND social_accounts.platform IN (${withMetrics.map(() => "?").join(",")})
          AND social_accounts.access_token IS NOT NULL
        ORDER BY posts.metrics_updated_at IS NOT NULL, posts.metrics_updated_at, posts.id
        LIMIT ?`,
    )
    .bind(now - WINDOW_SECONDS, ...withMetrics, limit)
    .all<Row>();

  let refreshed = 0;
  for (const post of results) {
    try {
      const metrics = await refreshOne(env, post, now);
      if (metrics) refreshed += 1;
    } catch (error) {
      console.error(JSON.stringify({ event: "metrics_refresh_failed", postId: post.id, platform: post.platform, error: String(error).slice(0, 300) }));
      if (/\b401\b/.test(String(error))) {
        await database
          .prepare("UPDATE social_accounts SET needs_reconnect_at = ?, reconnect_reason = ? WHERE id = ? AND needs_reconnect_at IS NULL")
          .bind(now, String(error).slice(0, 500), post.social_account_id)
          .run();
      }
    }
  }
  return { checked: results.length, refreshed };
}

/** Fetches and stores one post's metrics. Returns false if the platform has none to give. */
export async function refreshOne(
  env: Env,
  post: Pick<Row, "id" | "platform" | "platform_post_id" | "access_token" | "refresh_token" | "token_expires_at" | "external_account_id" | "metadata_json" | "social_account_id">,
  now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const database = env.DB;
  const adapter = ADAPTERS[post.platform];
  if (!adapter?.fetchMetrics || !post.access_token) return false;
  const metrics = await adapter.fetchMetrics({
    platformPostId: post.platform_post_id,
    accessToken: post.access_token,
    refreshToken: post.refresh_token,
    tokenExpiresAt: post.token_expires_at,
    saveTokens: (accessToken, refreshToken, expiresAt) => saveAccountTokens(database, post.social_account_id, accessToken, refreshToken, expiresAt),
    env,
    externalAccountId: post.external_account_id,
    metadata: JSON.parse(post.metadata_json) as Record<string, any>,
  });
  if (!metrics) {
    // Still stamp it, so a deleted post does not starve the others in the queue.
    await database.prepare("UPDATE posts SET metrics_updated_at = ? WHERE id = ?").bind(now, post.id).run();
    return false;
  }
  await database
    .prepare("UPDATE posts SET metric_views = ?, metric_likes = ?, metric_comments = ?, metric_shares = ?, metrics_updated_at = ? WHERE id = ?")
    .bind(metrics.views, metrics.likes, metrics.comments, metrics.shares, now, post.id)
    .run();
  return true;
}
