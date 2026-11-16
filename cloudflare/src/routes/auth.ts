import { Hono } from "hono";

import { mailConfigured, sendMail } from "../lib/mailer";
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
 * Not ported yet: Google sign-in and account deletion.
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

// --- Password reset and email verification ------------------------------
// Links point at `${origin}/reset-password` and `/api/auth/verify-email`; the
// reset page itself arrives with the UI port, and the API works without it.

const RESET_TTL_SECONDS = 60 * 60;
const VERIFY_TTL_SECONDS = 24 * 60 * 60;

async function createUserToken(database: D1Database, userId: number, purpose: "password_reset" | "email_verification", ttlSeconds: number): Promise<string> {
  const token = hex(randomBytes(32));
  await database.batch([
    // One live token per purpose: asking again invalidates the earlier link.
    database.prepare("DELETE FROM user_tokens WHERE user_id = ? AND purpose = ?").bind(userId, purpose),
    database
      .prepare("INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at) VALUES (?, ?, ?, unixepoch() + ?)")
      .bind(userId, purpose, await sha256Hex(token), ttlSeconds),
  ]);
  return token;
}

async function consumeUserToken(database: D1Database, token: string, purpose: "password_reset" | "email_verification"): Promise<number | null> {
  const row = await database
    .prepare("DELETE FROM user_tokens WHERE token_hash = ? AND purpose = ? AND expires_at > unixepoch() RETURNING user_id")
    .bind(await sha256Hex(token), purpose)
    .first<{ user_id: number }>();
  return row?.user_id ?? null;
}

auth.post("/auth/forgot-password", authRateLimit, async (context) => {
  const body = await jsonBody(context.req.raw);
  const email = parseEmail(body.email);
  if (!email) return context.json(validationError("email", "A valid email address is required"), 400);

  // Always 204, and the work happens after the response, so neither the status
  // nor the timing says whether the address has an account.
  context.executionCtx.waitUntil(
    (async () => {
      const user = await context.env.DB.prepare("SELECT id FROM users WHERE email = ? AND suspended_at IS NULL").bind(email).first<{ id: number }>();
      logAuthEvent(context, "password_reset_request", { userId: user?.id ?? null, email });
      if (!user || !mailConfigured(context.env)) return;
      const token = await createUserToken(context.env.DB, user.id, "password_reset", RESET_TTL_SECONDS);
      const link = `${new URL(context.req.url).origin}/reset-password?token=${token}`;
      await sendMail(context.env, {
        to: email,
        subject: "Reset your Postfalcon password",
        text: `Reset your password (the link works once, for one hour):\n${link}\n\nIf you didn't ask for this, ignore this email.`,
        category: "password_reset",
        userId: user.id,
      });
    })().catch((error: unknown) => console.error(JSON.stringify({ event: "forgot_password_failed", error: String(error) }))),
  );
  return context.body(null, 204);
});

auth.post("/auth/reset-password", authRateLimit, async (context) => {
  const database = context.env.DB;
  const body = await jsonBody(context.req.raw);
  const token = typeof body.token === "string" ? body.token : "";
  const password = parseNewPassword(body.password);
  if (!password) return context.json(validationError("password", "Password must be 8 to 255 characters"), 400);
  const userId = token ? await consumeUserToken(database, token, "password_reset") : null;
  if (!userId) return context.json({ error: "invalid or expired token" }, 400);

  const user = await database.prepare("UPDATE users SET password_hash = ? WHERE id = ? RETURNING email").bind(await hashPassword(password), userId).first<{ email: string }>();
  // Everyone signed in with the old password is signed out.
  await revokeOtherSessions(database, userId, null);
  logAuthEvent(context, "password_reset_complete", { userId, email: user?.email ?? null });
  return context.body(null, 204);
});

auth.get("/auth/verify-email", async (context) => {
  const token = context.req.query("token");
  const userId = token ? await consumeUserToken(context.env.DB, token, "email_verification") : null;
  if (!userId) return context.text("Invalid or expired verification link.", 400);
  const user = await context.env.DB.prepare("UPDATE users SET email_verified_at = unixepoch() WHERE id = ? RETURNING email").bind(userId).first<{ email: string }>();
  logAuthEvent(context, "email_verified", { userId, email: user?.email ?? null });
  return context.redirect("/login?verified=1");
});

auth.post("/auth/resend-verification", requireAuth, authRateLimit, async (context) => {
  const user = context.get("user");
  if (!mailConfigured(context.env)) return context.json({ error: "email_not_configured", message: "Email is not set up on this server." }, 503);
  const token = await createUserToken(context.env.DB, user.id, "email_verification", VERIFY_TTL_SECONDS);
  const link = `${new URL(context.req.url).origin}/api/auth/verify-email?token=${token}`;
  const result = await sendMail(context.env, { to: user.email, subject: "Verify your Postfalcon email", text: `Verify your email:\n${link}`, category: "email_verification", userId: user.id });
  return result.status === "sent" ? context.body(null, 204) : context.json({ error: "email_failed", message: "The email could not be sent." }, 502);
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
