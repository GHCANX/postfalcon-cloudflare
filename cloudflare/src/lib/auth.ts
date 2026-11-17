import type { Context, MiddlewareHandler } from "hono";

import { sha256Hex } from "./crypto";
import { passesCsrfCheck } from "./csrf";
import { hitRateLimit } from "./rate-limit";
import { readSession } from "./sessions";
import type { InstanceSettings } from "./instance-settings";

export type AuthUser = {
  id: number;
  email: string;
  isAdmin: boolean;
  emailVerifiedAt: number | null;
  createdAt: number;
  hasPassword: boolean;
};

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: AuthUser;
    authKind: "session" | "bearer";
    /** Set for a cookie session only: the stored identifier of that session. */
    sessionTokenHash: string | null;
    /** Resolved instance settings for this request (set by the pages router). */
    instanceSettings: InstanceSettings;
  };
};

type UserRow = {
  id: number;
  email: string;
  is_admin: number;
  email_verified_at: number | null;
  created_at: number;
  has_password: number;
};

const USER_COLUMNS = `users.id, users.email, users.is_admin, users.email_verified_at, users.created_at,
                      (users.password_hash IS NOT NULL) AS has_password`;

function toUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    isAdmin: row.is_admin === 1,
    emailVerifiedAt: row.email_verified_at,
    createdAt: row.created_at,
    hasPassword: row.has_password === 1,
  };
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

export function clientAddress(context: Context<AppEnv>): string | null {
  return context.req.header("cf-connecting-ip") ?? null;
}

/**
 * Resolves the caller from a Bearer API token or the session cookie. API
 * tokens are stored as plain SHA-256, the same as the Docker app, so a token
 * issued there keeps working after its row is imported.
 */
async function authenticate(
  context: Context<AppEnv>,
): Promise<{ user: AuthUser; kind: "session" | "bearer"; sessionTokenHash: string | null } | null> {
  const database = context.env.DB;
  const token = bearerToken(context.req.raw);

  if (token) {
    const tokenHash = await sha256Hex(token);
    const row = await database
      .prepare(
        `SELECT ${USER_COLUMNS}
           FROM api_tokens
           JOIN users ON users.id = api_tokens.user_id
          WHERE api_tokens.token_hash = ? AND users.suspended_at IS NULL`,
      )
      .bind(tokenHash)
      .first<UserRow>();
    if (!row) return null;
    context.executionCtx.waitUntil(
      database
        .prepare("UPDATE api_tokens SET last_used_at = unixepoch() WHERE token_hash = ? AND last_used_at IS NOT unixepoch()")
        .bind(tokenHash)
        .run()
        .catch(() => undefined),
    );
    return { user: toUser(row), kind: "bearer", sessionTokenHash: null };
  }

  const session = await readSession(context.req.raw, database, context.env.SESSION_SECRET);
  if (!session) return null;
  const row = await database
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? AND suspended_at IS NULL`)
    .bind(session.userId)
    .first<UserRow>();
  if (!row) return null;
  return { user: toUser(row), kind: "session", sessionTokenHash: session.tokenHash };
}

/** The signed-in user from the session cookie only (browser pages never accept a Bearer token). */
export async function sessionUser(context: Context<AppEnv>): Promise<AuthUser | null> {
  const secret = context.env.SESSION_SECRET;
  if (typeof secret !== "string" || secret.length < 32) return null;
  const session = await readSession(context.req.raw, context.env.DB, secret);
  if (!session) return null;
  const row = await context.env.DB
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? AND suspended_at IS NULL`)
    .bind(session.userId)
    .first<UserRow>();
  return row ? toUser(row) : null;
}

/** Rejects every /api request until the instance has a usable session secret. */
export const requireConfiguredSecrets: MiddlewareHandler<AppEnv> = async (context, next) => {
  const secret = context.env.SESSION_SECRET;
  if (typeof secret !== "string" || secret.length < 32) {
    console.error(JSON.stringify({ event: "session_secret_missing" }));
    return context.json({ error: "not_configured" }, 503);
  }
  await next();
};

/**
 * CSRF check for state-changing requests. A request carrying a Bearer header
 * is exempt: that header cannot be attached by another site's page, and API
 * clients never hold a CSRF token.
 */
export const csrfProtection: MiddlewareHandler<AppEnv> = async (context, next) => {
  const method = context.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  if (context.req.header("authorization")?.startsWith("Bearer ")) return next();
  if (!(await passesCsrfCheck(context.req.raw, context.env.SESSION_SECRET))) {
    return context.json({ error: "invalid_csrf_token" }, 403);
  }
  await next();
};

export const requireAuth: MiddlewareHandler<AppEnv> = async (context, next) => {
  const result = await authenticate(context);
  if (!result) return context.json({ error: "not authenticated" }, 401);
  context.set("user", result.user);
  context.set("authKind", result.kind);
  context.set("sessionTokenHash", result.sessionTokenHash);
  await next();
};

/** 10 requests per 15 minutes per client address, shared by all sign-in routes. */
export const authRateLimit: MiddlewareHandler<AppEnv> = async (context, next) => {
  const result = await hitRateLimit(context.env.DB, context.env.SESSION_SECRET, "auth", clientAddress(context));
  context.header("RateLimit-Limit", String(result.limit));
  context.header("RateLimit-Remaining", String(result.remaining));
  context.header("RateLimit-Reset", String(result.retryAfterSeconds));
  if (!result.allowed) {
    context.header("Retry-After", String(result.retryAfterSeconds));
    return context.json({ error: "too_many_requests" }, 429);
  }
  await next();
};

export type AuthEventType =
  | "login_success"
  | "login_failure"
  | "logout"
  | "signup"
  | "password_change"
  | "password_reset_request"
  | "password_reset_complete"
  | "email_verified"
  | "api_token_created"
  | "api_token_revoked";

/** Records an auth event after the response; a failure here is only logged. */
export function logAuthEvent(
  context: Context<AppEnv>,
  eventType: AuthEventType,
  subject: { userId?: number | null; email?: string | null },
): void {
  context.executionCtx.waitUntil(
    context.env.DB
      .prepare("INSERT INTO auth_events (user_id, email, event_type, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)")
      .bind(
        subject.userId ?? null,
        subject.email ?? null,
        eventType,
        clientAddress(context),
        context.req.header("user-agent")?.slice(0, 500) ?? null,
      )
      .run()
      .catch((error: unknown) =>
        console.error(JSON.stringify({ event: "auth_event_record_failed", eventType, error: String(error) })),
      ),
  );
}
