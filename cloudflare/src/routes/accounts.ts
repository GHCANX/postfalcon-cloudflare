import { Hono } from "hono";

import { type AppEnv, requireAuth } from "../lib/auth";

/**
 * Connected social accounts. Mounted at /api/social-accounts and
 * /api/v1/social-accounts, both Bearer- or session-authenticated.
 *
 * Accounts are never created here: each platform has its own connect route
 * that verifies the credential with the platform first (the Docker app allows
 * manual creation only for stub platforms, which this port does not have).
 */
export const accountRoutes = new Hono<AppEnv>();
accountRoutes.use("*", requireAuth);

const SEVEN_DAYS = 7 * 24 * 60 * 60;

export function iso(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

type AccountRow = {
  id: number;
  platform: string;
  display_name: string;
  external_account_id: string | null;
  avatar_url: string | null;
  created_at: number;
  needs_reconnect_at: number | null;
  reconnect_reason: string | null;
  token_expires_at: number | null;
  expires_soon: number;
};

accountRoutes.get("/", async (context) => {
  const { results } = await context.env.DB
    .prepare(
      `SELECT id, platform, display_name, external_account_id, avatar_url, created_at,
              needs_reconnect_at, reconnect_reason, token_expires_at,
              -- No refresh token means the access token simply dies at
              -- token_expires_at; warn a week ahead.
              (refresh_token IS NULL AND token_expires_at IS NOT NULL
                AND token_expires_at < unixepoch() + ?) AS expires_soon
         FROM social_accounts WHERE user_id = ? ORDER BY created_at, id`,
    )
    .bind(SEVEN_DAYS, context.get("user").id)
    .all<AccountRow>();

  return context.json(
    results.map((row) => ({
      ...row,
      created_at: iso(row.created_at),
      needs_reconnect_at: iso(row.needs_reconnect_at),
      token_expires_at: iso(row.token_expires_at),
      expires_soon: row.expires_soon === 1,
    })),
  );
});

accountRoutes.delete("/:id", async (context) => {
  const id = Number(context.req.param("id"));
  if (!Number.isSafeInteger(id)) return context.json({ error: "invalid id" }, 400);
  const userId = context.get("user").id;
  const database = context.env.DB;

  // Deleting the account cascades to its posts and their media references;
  // the stored files are released by the reference-counted media sweep.
  const removed = await database
    .prepare("DELETE FROM social_accounts WHERE id = ? AND user_id = ? RETURNING id, platform")
    .bind(id, userId)
    .first<{ id: number; platform: string }>();
  if (!removed) return context.json({ error: "not found" }, 404);

  context.executionCtx.waitUntil(
    database
      .prepare("INSERT INTO product_events (user_id, event_name, metadata_json) VALUES (?, 'social_account_disconnected', ?)")
      .bind(userId, JSON.stringify({ platform: removed.platform, socialAccountId: id }))
      .run()
      .catch(() => undefined),
  );
  return context.body(null, 204);
});
