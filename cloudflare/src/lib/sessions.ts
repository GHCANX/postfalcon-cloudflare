import { base64Url, hmacHex, randomBytes } from "./crypto";

const SESSION_COOKIE_NAME = "__Host-postfalcon_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
// last_seen_at is informational; refreshing it at most this often keeps an
// active browser from costing one D1 write per request.
const LAST_SEEN_REFRESH_SECONDS = 5 * 60;

export function firstCookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  const prefix = `${name}=`;
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return null;
}

/** The stored identifier of the session cookie on this request, if it has one. */
export async function presentedSessionHash(request: Request, sessionSecret: string): Promise<string | null> {
  const token = firstCookieValue(request, SESSION_COOKIE_NAME);
  return token ? hmacHex(sessionSecret, token) : null;
}

export type SessionRecord = {
  userId: number;
  expiresAt: number;
  /** The stored identifier of this session; never the cookie value. */
  tokenHash: string;
};

export async function createSession(
  database: D1Database,
  sessionSecret: string,
  userId: number,
  userAgent: string | null,
  now = Math.floor(Date.now() / 1000),
): Promise<{ token: string; tokenHash: string; expiresAt: number }> {
  const token = base64Url(randomBytes(32));
  const expiresAt = now + SESSION_TTL_SECONDS;
  const [tokenHash, userAgentHash] = await Promise.all([
    hmacHex(sessionSecret, token),
    userAgent ? hmacHex(sessionSecret, userAgent) : Promise.resolve(null),
  ]);

  await database
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at, user_agent_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(tokenHash, userId, expiresAt, now, now, userAgentHash)
    .run();

  return { token, tokenHash, expiresAt };
}

export async function readSession(
  request: Request,
  database: D1Database,
  sessionSecret: string,
  now = Math.floor(Date.now() / 1000),
): Promise<SessionRecord | null> {
  const tokenHash = await presentedSessionHash(request, sessionSecret);
  if (!tokenHash) return null;
  const session = await database
    .prepare(
      `SELECT user_id AS userId, expires_at AS expiresAt, last_seen_at AS lastSeenAt
         FROM sessions
        WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .bind(tokenHash, now)
    .first<{ userId: number; expiresAt: number; lastSeenAt: number }>();

  if (!session) return null;
  if (now - session.lastSeenAt >= LAST_SEEN_REFRESH_SECONDS) {
    await database.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").bind(now, tokenHash).run();
  }
  return { userId: session.userId, expiresAt: session.expiresAt, tokenHash };
}

export async function revokeSession(request: Request, database: D1Database, sessionSecret: string): Promise<void> {
  const tokenHash = await presentedSessionHash(request, sessionSecret);
  if (!tokenHash) return;
  await database.prepare("UPDATE sessions SET revoked_at = unixepoch() WHERE token_hash = ?").bind(tokenHash).run();
}

/** Signs a user out everywhere except the session named by `keepTokenHash`. */
export async function revokeOtherSessions(database: D1Database, userId: number, keepTokenHash: string | null): Promise<void> {
  await database
    .prepare("UPDATE sessions SET revoked_at = unixepoch() WHERE user_id = ? AND revoked_at IS NULL AND token_hash IS NOT ?")
    .bind(userId, keepTokenHash)
    .run();
}

export function sessionCookie(token: string, expiresAt: number): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Expires=${new Date(expiresAt * 1000).toUTCString()}; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function expiredSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export async function purgeExpiredSessions(database: D1Database, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await database.prepare("DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").bind(now).run();
}
