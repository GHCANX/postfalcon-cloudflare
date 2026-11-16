import { Hono } from "hono";

import { type AppEnv, requireAuth } from "../lib/auth";

/**
 * Token-style platform connections (the user supplies a credential and we
 * verify it with the platform before storing anything). OAuth platforms come
 * in later slices of the platform work item.
 */
export const connectRoutes = new Hono<AppEnv>();
connectRoutes.use("*", requireAuth);

const PDS = "https://bsky.social";
const TELEGRAM = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 10_000;

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function fetchJson(url: string, init: RequestInit): Promise<{ ok: boolean; data: Record<string, any> }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const data = (await response.json().catch(() => ({}))) as Record<string, any>;
  return { ok: response.ok, data };
}

/** Insert or refresh an account; returns its id and whether it is new. */
async function saveAccount(
  database: D1Database,
  userId: number,
  platform: string,
  displayName: string,
  externalId: string,
  token: string,
  metadata: Record<string, unknown>,
): Promise<{ id: number; inserted: boolean }> {
  const existing = await database
    .prepare("SELECT id FROM social_accounts WHERE user_id = ? AND platform = ? AND external_account_id = ?")
    .bind(userId, platform, externalId)
    .first<{ id: number }>();

  if (existing) {
    await database
      .prepare("UPDATE social_accounts SET display_name = ?, access_token = ?, metadata_json = ? WHERE id = ?")
      .bind(displayName, token, JSON.stringify(metadata), existing.id)
      .run();
    return { id: existing.id, inserted: false };
  }

  const row = await database
    .prepare(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(userId, platform, displayName, externalId, token, JSON.stringify(metadata))
    .first<{ id: number }>();
  if (!row) throw new Error("Account insert returned no row");
  return { id: row.id, inserted: true };
}

function recordConnected(database: D1Database, executionCtx: { waitUntil(promise: Promise<unknown>): void }, userId: number, platform: string, id: number): void {
  executionCtx.waitUntil(
    database
      .prepare("INSERT INTO product_events (user_id, event_name, metadata_json) VALUES (?, 'social_account_connected', ?)")
      .bind(userId, JSON.stringify({ platform, socialAccountId: id }))
      .run()
      .catch(() => undefined),
  );
}

// Bluesky: a handle plus an app password (Settings -> App Passwords). Verified
// by logging in right now; the adapter logs in fresh on every publish.
connectRoutes.post("/bluesky/connect", async (context) => {
  const body = await jsonBody(context.req.raw);
  const handle = text(body.handle, 255);
  const appPassword = text(body.app_password, 64);
  if (!handle) return context.json({ error: "validation_error", details: [{ path: "handle", message: "Required" }] }, 400);
  if (!/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/i.test(appPassword)) {
    return context.json(
      { error: "validation_error", details: [{ path: "app_password", message: "that does not look like a Bluesky app password" }] },
      400,
    );
  }

  const session = await fetchJson(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: handle, password: appPassword }),
  }).catch(() => null);
  if (!session) return context.json({ error: "platform_unreachable", message: "Bluesky could not be reached. Try again." }, 502);
  if (!session.ok || typeof session.data.did !== "string") {
    return context.json({ error: "invalid_credentials", message: "Bluesky did not accept that handle and app password." }, 400);
  }

  const userId = context.get("user").id;
  const displayName = session.data.handle ? `@${session.data.handle}` : handle;
  const saved = await saveAccount(context.env.DB, userId, "bluesky", displayName, session.data.did, appPassword, {});
  if (saved.inserted) recordConnected(context.env.DB, context.executionCtx, userId, "bluesky", saved.id);
  return context.json({ id: saved.id, display_name: displayName }, 201);
});

// Telegram: a bot token plus the channel it posts to. Verified with getMe and
// getChat before anything is stored.
connectRoutes.post("/telegram/connect", async (context) => {
  const body = await jsonBody(context.req.raw);
  const token = text(body.token, 200);
  const chatId = text(body.chat_id, 255);
  if (!/^\d{6,}:[\w-]{30,}$/.test(token)) {
    return context.json(
      { error: "validation_error", details: [{ path: "token", message: "that does not look like a Telegram bot token" }] },
      400,
    );
  }
  if (!chatId) return context.json({ error: "validation_error", details: [{ path: "chat_id", message: "Required" }] }, 400);

  const call = (method: string, params?: Record<string, unknown>) =>
    fetchJson(`${TELEGRAM}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params ?? {}),
    }).then((result) => ({ ok: result.ok && result.data.ok === true, result: result.data.result as Record<string, any> | undefined }));

  const me = await call("getMe").catch(() => null);
  if (!me) return context.json({ error: "platform_unreachable", message: "Telegram could not be reached. Try again." }, 502);
  if (!me.ok || !me.result) return context.json({ error: "invalid_token", message: "Telegram did not accept that bot token." }, 400);

  const chat = await call("getChat", { chat_id: chatId }).catch(() => null);
  if (!chat) return context.json({ error: "platform_unreachable", message: "Telegram could not be reached. Try again." }, 502);
  if (!chat.ok || !chat.result) {
    return context.json(
      { error: "chat_unreachable", message: `The bot can't see ${chatId}. Add @${me.result.username} to the channel as an admin and try again.` },
      400,
    );
  }

  const userId = context.get("user").id;
  const displayName = chat.result.title || (chat.result.username ? `@${chat.result.username}` : chatId);
  const saved = await saveAccount(context.env.DB, userId, "telegram", displayName, String(chat.result.id), token, {
    botUsername: me.result.username,
    chatType: chat.result.type,
  });
  if (saved.inserted) recordConnected(context.env.DB, context.executionCtx, userId, "telegram", saved.id);
  return context.json({ id: saved.id, display_name: displayName }, 201);
});
