const SESSION_COOKIE_NAME = "__Host-postfalcon_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function secureToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function firstCookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  const prefix = `${name}=`;
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return null;
}

export type SessionRecord = {
  userId: number;
  expiresAt: number;
};

export async function createSession(
  database: D1Database,
  sessionSecret: string,
  userId: number,
  userAgent: string | null,
  now = Math.floor(Date.now() / 1000),
): Promise<{ token: string; expiresAt: number }> {
  const token = secureToken();
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

  return { token, expiresAt };
}

export async function readSession(
  request: Request,
  database: D1Database,
  sessionSecret: string,
  now = Math.floor(Date.now() / 1000),
): Promise<SessionRecord | null> {
  const token = firstCookieValue(request, SESSION_COOKIE_NAME);
  if (!token) return null;

  const tokenHash = await hmacHex(sessionSecret, token);
  const session = await database
    .prepare(
      `SELECT user_id AS userId, expires_at AS expiresAt
         FROM sessions
        WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .bind(tokenHash, now)
    .first<SessionRecord>();

  if (!session) return null;
  await database.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").bind(now, tokenHash).run();
  return session;
}

export async function revokeSession(request: Request, database: D1Database, sessionSecret: string): Promise<void> {
  const token = firstCookieValue(request, SESSION_COOKIE_NAME);
  if (!token) return;
  const tokenHash = await hmacHex(sessionSecret, token);
  await database.prepare("UPDATE sessions SET revoked_at = unixepoch() WHERE token_hash = ?").bind(tokenHash).run();
}

export function sessionCookie(token: string, expiresAt: number): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Expires=${new Date(expiresAt * 1000).toUTCString()}; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function expiredSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export async function purgeExpiredSessions(database: D1Database, now = Math.floor(Date.now() / 1000)): Promise<number> {
  const result = await database.prepare("DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").bind(now).run();
  return result.meta.changes;
}
