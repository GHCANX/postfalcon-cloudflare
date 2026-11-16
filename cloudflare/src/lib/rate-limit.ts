import { hmacHex } from "./crypto";

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

const AUTH_LIMIT = 10;
const AUTH_WINDOW_SECONDS = 15 * 60;

/**
 * Counts one request against a fixed window in D1 and reports whether it is
 * still within the limit. The counter is one atomic upsert, so concurrent
 * requests cannot both take the last slot.
 */
export async function hitRateLimit(
  database: D1Database,
  secret: string,
  scope: string,
  clientAddress: string | null,
  limit = AUTH_LIMIT,
  windowSeconds = AUTH_WINDOW_SECONDS,
  now = Math.floor(Date.now() / 1000),
): Promise<RateLimitResult> {
  const windowStart = now - (now % windowSeconds);
  const key = `${scope}:${await hmacHex(secret, clientAddress ?? "unknown")}`;
  const row = await database
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();

  const count = row?.count ?? limit + 1;
  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: windowStart + windowSeconds - now,
  };
}

export async function purgeRateLimits(database: D1Database, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await database.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now - 24 * 60 * 60).run();
}
