import { Hono } from "hono";

import { type AppEnv, requireAuth } from "../lib/auth";
import { consumeOAuthState, createOAuthState, publicOrigin, sanitizeUrl } from "../lib/oauth";
import { upsertAccount } from "../lib/accounts";

/**
 * Browser-navigated OAuth connect flows, mounted under /api/<platform>. They
 * redirect back to /accounts the way the Docker app does. The state is bound
 * to the signed-in user and consumed on first use.
 */
export const oauthRoutes = new Hono<AppEnv>();
oauthRoutes.use("*", requireAuth);

const TIMEOUT_MS = 10_000;
const MASTODON_SCOPE = "read write";
const INSTANCE_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function normalizeInstance(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const host = raw.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  // A numeric last label means an IP address, which is never a Mastodon server.
  if (!INSTANCE_RE.test(host) || /^\d+$/.test(host.split(".").pop() ?? "")) return null;
  return host;
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, any> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "manual",
  });
  return { ok: response.ok, status: response.status, data: (await response.json().catch(() => ({}))) as Record<string, any> };
}

async function mastodonApp(
  database: D1Database,
  instance: string,
  redirectUri: string,
  origin: string,
): Promise<{ client_id: string; client_secret: string }> {
  const existing = await database
    .prepare("SELECT client_id, client_secret, redirect_uri FROM mastodon_apps WHERE instance = ?")
    .bind(instance)
    .first<{ client_id: string; client_secret: string; redirect_uri: string | null }>();
  if (existing && existing.redirect_uri === redirectUri) return existing;

  const registered = await postJson(`https://${instance}/api/v1/apps`, {
    client_name: "Postfalcon",
    redirect_uris: redirectUri,
    scopes: MASTODON_SCOPE,
    website: origin,
  });
  if (!registered.ok || typeof registered.data.client_id !== "string" || typeof registered.data.client_secret !== "string") {
    throw new Error(`Failed to register app on ${instance} (status ${registered.status})`);
  }
  await database
    .prepare(
      `INSERT INTO mastodon_apps (instance, client_id, client_secret, redirect_uri) VALUES (?, ?, ?, ?)
       ON CONFLICT (instance) DO UPDATE SET client_id = excluded.client_id,
         client_secret = excluded.client_secret, redirect_uri = excluded.redirect_uri`,
    )
    .bind(instance, registered.data.client_id, registered.data.client_secret, redirectUri)
    .run();
  return { client_id: registered.data.client_id, client_secret: registered.data.client_secret };
}

oauthRoutes.get("/mastodon/connect", async (context) => {
  const instance = normalizeInstance(context.req.query("instance"));
  if (!instance) return context.text("Enter a valid Mastodon instance domain, e.g. mastodon.social", 400);

  const origin = publicOrigin(context.req.raw);
  const redirectUri = `${origin}/api/mastodon/callback`;
  let app;
  try {
    app = await mastodonApp(context.env.DB, instance, redirectUri, origin);
  } catch (error) {
    console.error(JSON.stringify({ event: "mastodon_register_failed", instance, error: String(error) }));
    return context.text(`Could not register with ${instance}. Check the address and try again.`, 502);
  }

  const state = await createOAuthState(context.env.DB, context.get("user").id, "mastodon", { instance });
  const authorize = new URL(`https://${instance}/oauth/authorize`);
  authorize.searchParams.set("client_id", app.client_id);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", MASTODON_SCOPE);
  authorize.searchParams.set("state", state);
  return context.redirect(authorize.toString());
});

oauthRoutes.get("/mastodon/callback", async (context) => {
  const code = context.req.query("code");
  const state = context.req.query("state");
  const user = context.get("user");
  const pending = state ? await consumeOAuthState(context.env.DB, state, user.id, "mastodon") : null;
  if (!pending || !code || typeof pending.instance !== "string") {
    return context.text("Invalid or expired OAuth state. Please try connecting again.", 400);
  }

  const instance = pending.instance;
  const origin = publicOrigin(context.req.raw);
  const redirectUri = `${origin}/api/mastodon/callback`;
  try {
    const app = await mastodonApp(context.env.DB, instance, redirectUri, origin);
    const token = await postJson(`https://${instance}/oauth/token`, {
      client_id: app.client_id,
      client_secret: app.client_secret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code,
      scope: MASTODON_SCOPE,
    });
    if (!token.ok || typeof token.data.access_token !== "string") {
      return context.text("Failed to exchange authorization code with Mastodon.", 502);
    }

    const profile = await fetch(`https://${instance}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${token.data.access_token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual",
    });
    const account = (await profile.json().catch(() => ({}))) as Record<string, any>;
    if (!profile.ok || typeof account.id !== "string" || typeof account.username !== "string") {
      return context.text("Failed to fetch Mastodon account details.", 502);
    }

    const saved = await upsertAccount(context.env.DB, {
      userId: user.id,
      platform: "mastodon",
      displayName: `@${account.username}@${instance}`,
      externalId: account.id,
      accessToken: token.data.access_token,
      metadata: { instance },
      avatarUrl: sanitizeUrl(account.avatar),
    });
    if (saved.inserted) {
      context.executionCtx.waitUntil(
        context.env.DB
          .prepare("INSERT INTO product_events (user_id, event_name, metadata_json) VALUES (?, 'social_account_connected', ?)")
          .bind(user.id, JSON.stringify({ platform: "mastodon", socialAccountId: saved.id }))
          .run()
          .catch(() => undefined),
      );
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "mastodon_callback_failed", instance, error: String(error) }));
    return context.text("Could not complete the Mastodon connection. Please try again.", 502);
  }
  return context.redirect("/accounts");
});
