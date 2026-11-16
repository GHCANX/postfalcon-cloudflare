import { Hono } from "hono";

import { type AppEnv, authRateLimit, logAuthEvent, requireAuth } from "../lib/auth";
import { hex, randomBytes, sha256Hex, timingSafeEqualStrings } from "../lib/crypto";
import { issueCsrfToken } from "../lib/csrf";
import { burnPasswordCheck, hashPassword, verifyPassword } from "../lib/passwords";
import {
  createSession,
  expiredSessionCookie,
  presentedSessionHash,
  revokeOtherSessions,
  revokeSession,
  sessionCookie,
} from "../lib/sessions";

/**
 * Identity routes for the single-owner instance, mounted under /api. The paths
 * and JSON shapes follow the Docker app (routes/auth.js, routes/users.js) so
 * its browser code can be served unchanged later.
 *
 * Not ported yet: password reset and email verification (they need the
 * Mailgun work item), Google sign-in, and account deletion.
 */
const auth = new Hono<AppEnv>();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 255 && EMAIL_PATTERN.test(email) ? email : null;
}

function parseNewPassword(value: unknown): string | null {
  return typeof value === "string" && value.length >= 8 && value.length <= 255 ? value : null;
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function validationError(field: string, message: string) {
  return { error: "validation_error", details: [{ path: field, message }] };
}

auth.get("/csrf-token", async (context) => {
  const { token, cookie } = await issueCsrfToken(context.req.raw, context.env.SESSION_SECRET);
  if (cookie) context.header("Set-Cookie", cookie);
  return context.json({ csrfToken: token });
});

// --- Owner setup -----------------------------------------------------------
// The instance has exactly one account. It is created once, by whoever holds
// the SETUP_TOKEN secret, and no other route can create a user.

async function ownerExists(database: D1Database): Promise<boolean> {
  return (await database.prepare("SELECT 1 AS present FROM users LIMIT 1").first()) !== null;
}

auth.get("/setup", async (context) => context.json({ needed: !(await ownerExists(context.env.DB)) }));

auth.post("/setup", authRateLimit, async (context) => {
  const database = context.env.DB;
  if (await ownerExists(database)) return context.json({ error: "already_set_up" }, 409);

  const setupToken = context.env.SETUP_TOKEN;
  if (typeof setupToken !== "string" || setupToken.length < 32) return context.json({ error: "not_configured" }, 503);

  const body = await jsonBody(context.req.raw);
  const supplied = typeof body.setup_token === "string" ? body.setup_token : "";
  if (!(await timingSafeEqualStrings(supplied, setupToken))) {
    return context.json({ error: "invalid_setup_token" }, 403);
  }

  const email = parseEmail(body.email);
  if (!email) return context.json(validationError("email", "A valid email address is required"), 400);
  const password = parseNewPassword(body.password);
  if (!password) return context.json(validationError("password", "Password must be 8 to 255 characters"), 400);

  // One statement decides the race: the row is only inserted while the table
  // is empty. The setup token is the proof of ownership, so the address is
  // recorded as verified rather than waiting on an email this instance may
  // not be able to send yet.
  const passwordHash = await hashPassword(password);
  const owner = await database
    .prepare(
      `INSERT INTO users (email, password_hash, email_verified_at)
       SELECT ?, ?, unixepoch()
        WHERE NOT EXISTS (SELECT 1 FROM users)
       RETURNING id, email`,
    )
    .bind(email, passwordHash)
    .first<{ id: number; email: string }>();
  if (!owner) return context.json({ error: "already_set_up" }, 409);

  const session = await createSession(database, context.env.SESSION_SECRET, owner.id, context.req.header("user-agent") ?? null);
  context.header("Set-Cookie", sessionCookie(session.token, session.expiresAt));
  logAuthEvent(context, "signup", { userId: owner.id, email: owner.email });
  return context.json({ id: owner.id, email: owner.email }, 201);
});

// Open registration does not exist in the single-owner profile.
auth.post("/users", (context) =>
  context.json({ error: "signups_closed", message: "This server does not accept new sign-ups." }, 403),
);

// --- Sign in / out ---------------------------------------------------------

auth.post("/auth/login", authRateLimit, async (context) => {
  const database = context.env.DB;
  const body = await jsonBody(context.req.raw);
  const email = parseEmail(body.email);
  const password = typeof body.password === "string" && body.password.length > 0 ? body.password : null;
  if (!email) return context.json(validationError("email", "A valid email address is required"), 400);
  if (!password || password.length > 255) return context.json(validationError("password", "Password is required"), 400);

  const user = await database
    .prepare("SELECT id, email, password_hash, suspended_at FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: number; email: string; password_hash: string | null; suspended_at: number | null }>();

  // Same answer and similar work whether the email is unknown, has no
  // password, or the password is wrong, so sign-in cannot probe for accounts.
  let passwordOk = false;
  let needsRehash = false;
  if (user?.password_hash) {
    ({ ok: passwordOk, needsRehash } = await verifyPassword(password, user.password_hash));
  } else {
    await burnPasswordCheck(password);
  }
  if (!user || !passwordOk) {
    logAuthEvent(context, "login_failure", { email });
    return context.json({ error: "invalid email or password" }, 401);
  }
  // Only said after the right password.
  if (user.suspended_at) return context.json({ error: "This account is suspended. Contact the site admin." }, 401);

  if (needsRehash) {
    await database.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(password), user.id).run();
  }

  // Always a fresh session token on sign-in; one presented with the request is retired.
  await revokeSession(context.req.raw, database, context.env.SESSION_SECRET);
  const session = await createSession(database, context.env.SESSION_SECRET, user.id, context.req.header("user-agent") ?? null);
  context.header("Set-Cookie", sessionCookie(session.token, session.expiresAt));
  logAuthEvent(context, "login_success", { userId: user.id, email: user.email });
  return context.json({ id: user.id, email: user.email });
});

auth.post("/auth/logout", async (context) => {
  const database = context.env.DB;
  const owner = await database
    .prepare(
      `SELECT users.id, users.email
         FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ? AND sessions.revoked_at IS NULL`,
    )
    .bind(await presentedSessionHash(context.req.raw, context.env.SESSION_SECRET))
    .first<{ id: number; email: string }>();

  await revokeSession(context.req.raw, database, context.env.SESSION_SECRET);
  context.header("Set-Cookie", expiredSessionCookie());
  if (owner) logAuthEvent(context, "logout", { userId: owner.id, email: owner.email });
  return context.body(null, 204);
});

auth.get("/auth/me", requireAuth, (context) => {
  const user = context.get("user");
  return context.json({ id: user.id, email: user.email });
});

// --- Password --------------------------------------------------------------

auth.post("/auth/change-password", requireAuth, authRateLimit, async (context) => {
  const database = context.env.DB;
  const user = context.get("user");
  const body = await jsonBody(context.req.raw);
  const newPassword = parseNewPassword(body.newPassword);
  if (!newPassword) return context.json(validationError("newPassword", "Password must be 8 to 255 characters"), 400);
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";

  const row = await database.prepare("SELECT password_hash FROM users WHERE id = ?").bind(user.id).first<{ password_hash: string | null }>();
  if (row?.password_hash && !(await verifyPassword(currentPassword, row.password_hash)).ok) {
    return context.json({ error: "current password is incorrect" }, 401);
  }

  await database.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(newPassword), user.id).run();
  // A stolen session cookie stops working once the password changes; the
  // session making this request stays signed in.
  await revokeOtherSessions(database, user.id, context.get("sessionTokenHash"));
  logAuthEvent(context, "password_change", { userId: user.id, email: user.email });
  return context.body(null, 204);
});

// --- API token -------------------------------------------------------------
// At most one per user, shown once, stored only as a SHA-256 hash.

auth.get("/auth/api-token", requireAuth, async (context) => {
  const row = await context.env.DB
    .prepare("SELECT created_at, last_used_at FROM api_tokens WHERE user_id = ?")
    .bind(context.get("user").id)
    .first<{ created_at: number; last_used_at: number | null }>();
  if (!row) return context.json({ exists: false });
  return context.json({ exists: true, created_at: isoTime(row.created_at), last_used_at: isoTime(row.last_used_at) });
});

auth.post("/auth/api-token", requireAuth, authRateLimit, async (context) => {
  const user = context.get("user");
  const token = `pf_${hex(randomBytes(24))}`;
  await context.env.DB.batch([
    context.env.DB.prepare("DELETE FROM api_tokens WHERE user_id = ?").bind(user.id),
    context.env.DB.prepare("INSERT INTO api_tokens (user_id, token_hash) VALUES (?, ?)").bind(user.id, await sha256Hex(token)),
  ]);
  logAuthEvent(context, "api_token_created", { userId: user.id, email: user.email });
  return context.json({ token }, 201);
});

auth.delete("/auth/api-token", requireAuth, async (context) => {
  const user = context.get("user");
  await context.env.DB.prepare("DELETE FROM api_tokens WHERE user_id = ?").bind(user.id).run();
  logAuthEvent(context, "api_token_revoked", { userId: user.id, email: user.email });
  return context.body(null, 204);
});

/** D1 stores Unix seconds; the API keeps the ISO strings the Docker app returns. */
function isoTime(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

export { auth as authRoutes };
