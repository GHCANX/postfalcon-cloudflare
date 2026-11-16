import { base64Url, randomBytes, sha256Hex } from "./crypto";

const STATE_TTL_SECONDS = 10 * 60;

/** Public origin of this Worker, used to build OAuth redirect URIs. */
export function publicOrigin(request: Request): string {
  return new URL(request.url).origin;
}

/** Stores pending OAuth data and returns the opaque `state` to send to the platform. */
export async function createOAuthState(
  database: D1Database,
  userId: number,
  platform: string,
  data: Record<string, unknown>,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const state = base64Url(randomBytes(24));
  await database
    .prepare("INSERT INTO oauth_states (state_hash, user_id, platform, data_json, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256Hex(state), userId, platform, JSON.stringify(data), now + STATE_TTL_SECONDS)
    .run();
  return state;
}

/**
 * Consumes a state: it is deleted whether or not it is valid for this caller,
 * so each value works at most once. Returns the stored data only when it was
 * issued to this user for this platform and has not expired.
 */
export async function consumeOAuthState(
  database: D1Database,
  state: string,
  userId: number,
  platform: string,
  now = Math.floor(Date.now() / 1000),
): Promise<Record<string, any> | null> {
  const row = await database
    .prepare("DELETE FROM oauth_states WHERE state_hash = ? RETURNING user_id, platform, data_json, expires_at")
    .bind(await sha256Hex(state))
    .first<{ user_id: number; platform: string; data_json: string; expires_at: number }>();
  if (!row || row.user_id !== userId || row.platform !== platform || row.expires_at <= now) return null;
  return JSON.parse(row.data_json) as Record<string, any>;
}

export async function purgeOAuthStates(database: D1Database, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await database.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").bind(now).run();
}

/** Drops anything that is not a well-formed http(s) URL (avatars come from third parties). */
export function sanitizeUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
