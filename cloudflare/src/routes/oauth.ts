import { Hono } from "hono";

import { type AppEnv, requireAuth } from "../lib/auth";
import { consumeOAuthState, createOAuthState, publicOrigin, sanitizeUrl } from "../lib/oauth";
import { upsertAccount } from "../lib/accounts";
import { freshAccessToken } from "../lib/oauth-refresh";
import { base64Url, randomBytes } from "../lib/crypto";
import { GRAPH } from "../platforms/instagram";
import { queryCreatorInfo, TIKTOK_API, tiktokRefreshRequest } from "../platforms/tiktok";

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

function recordConnected(database: D1Database, executionCtx: { waitUntil(promise: Promise<unknown>): void }, userId: number, platform: string, id: number): void {
  executionCtx.waitUntil(
    database
      .prepare("INSERT INTO product_events (user_id, event_name, metadata_json) VALUES (?, 'social_account_connected', ?)")
      .bind(userId, JSON.stringify({ platform, socialAccountId: id }))
      .run()
      .catch(() => undefined),
  );
}

async function getJson(url: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: Record<string, any> }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual" });
  return { ok: response.ok, status: response.status, data: (await response.json().catch(() => ({}))) as Record<string, any> };
}

// --- Instagram (through Facebook Login) -------------------------------------
// Instagram business accounts are reached through the Facebook Pages they are
// linked to, so the user logs in with Facebook. Each linked account is stored
// with its Page access token (long-lived, no refresh).

const FACEBOOK_SCOPE = "pages_show_list,pages_read_engagement,instagram_basic,instagram_content_publish";

oauthRoutes.get("/facebook/connect", async (context) => {
  const appId = context.env.FACEBOOK_APP_ID;
  if (!appId || !context.env.FACEBOOK_APP_SECRET) return context.text("Instagram is not configured on this server.", 503);
  const state = await createOAuthState(context.env.DB, context.get("user").id, "facebook", {});
  const authorize = new URL("https://www.facebook.com/v19.0/dialog/oauth");
  authorize.searchParams.set("client_id", appId);
  authorize.searchParams.set("redirect_uri", `${publicOrigin(context.req.raw)}/api/facebook/callback`);
  authorize.searchParams.set("state", state);
  // A Business-type Meta app takes a login configuration id instead of a scope list.
  if (context.env.FACEBOOK_CONFIG_ID) authorize.searchParams.set("config_id", context.env.FACEBOOK_CONFIG_ID);
  else authorize.searchParams.set("scope", FACEBOOK_SCOPE);
  return context.redirect(authorize.toString());
});

oauthRoutes.get("/facebook/callback", async (context) => {
  const code = context.req.query("code");
  const state = context.req.query("state");
  const user = context.get("user");
  const pending = state ? await consumeOAuthState(context.env.DB, state, user.id, "facebook") : null;
  if (!pending || !code) return context.text("Invalid or expired OAuth state. Please try connecting again.", 400);
  const appId = context.env.FACEBOOK_APP_ID;
  const appSecret = context.env.FACEBOOK_APP_SECRET;
  if (!appId || !appSecret) return context.text("Instagram is not configured on this server.", 503);

  const redirectUri = `${publicOrigin(context.req.raw)}/api/facebook/callback`;
  try {
    const exchange = (params: Record<string, string>) => {
      const url = new URL(`${GRAPH}/oauth/access_token`);
      for (const [key, value] of Object.entries({ client_id: appId, client_secret: appSecret, ...params })) url.searchParams.set(key, value);
      return getJson(url.toString());
    };
    const short = await exchange({ redirect_uri: redirectUri, code });
    if (!short.ok || typeof short.data.access_token !== "string") return context.text("Failed to exchange authorization code with Facebook.", 502);
    const long = await exchange({ grant_type: "fb_exchange_token", fb_exchange_token: short.data.access_token });
    if (!long.ok || typeof long.data.access_token !== "string") return context.text("Failed to obtain a long-lived Facebook token.", 502);

    const pages = await getJson(`${GRAPH}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(long.data.access_token)}`);
    if (!pages.ok) return context.text("Failed to fetch your Facebook Pages.", 502);
    const pageList = (Array.isArray(pages.data.data) ? pages.data.data : []) as { id: string; name: string; access_token: string }[];
    if (pageList.length === 0) return context.redirect("/accounts?error=facebook_no_pages");

    let connected = 0;
    for (const page of pageList) {
      const linked = await getJson(`${GRAPH}/${page.id}?fields=instagram_business_account&access_token=${encodeURIComponent(page.access_token)}`);
      const igId = linked.ok ? linked.data.instagram_business_account?.id : undefined;
      if (typeof igId !== "string") continue;
      const info = await getJson(`${GRAPH}/${igId}?fields=username,profile_picture_url&access_token=${encodeURIComponent(page.access_token)}`);
      const saved = await upsertAccount(context.env.DB, {
        userId: user.id,
        platform: "instagram",
        displayName: typeof info.data.username === "string" ? `@${info.data.username}` : `Instagram (${page.name})`,
        externalId: igId,
        accessToken: page.access_token,
        metadata: { pageId: page.id, pageName: page.name },
        avatarUrl: sanitizeUrl(info.data.profile_picture_url),
      });
      if (saved.inserted) recordConnected(context.env.DB, context.executionCtx, user.id, "instagram", saved.id);
      connected += 1;
    }
    if (connected === 0) return context.redirect("/accounts?error=instagram_none_linked");
  } catch (error) {
    console.error(JSON.stringify({ event: "facebook_callback_failed", error: String(error) }));
    return context.text("Could not complete the Instagram connection. Please try again.", 502);
  }
  return context.redirect("/accounts");
});

// --- TikTok ------------------------------------------------------------------

const TIKTOK_SCOPES = "user.info.basic,video.publish,video.upload";

oauthRoutes.get("/tiktok/connect", async (context) => {
  const clientKey = context.env.TIKTOK_CLIENT_KEY;
  if (!clientKey || !context.env.TIKTOK_CLIENT_SECRET) return context.text("TikTok is not configured on this server.", 503);
  const codeVerifier = base64Url(randomBytes(48));
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier))));
  const state = await createOAuthState(context.env.DB, context.get("user").id, "tiktok", { codeVerifier });
  const authorize = new URL("https://www.tiktok.com/v2/auth/authorize/");
  authorize.searchParams.set("client_key", clientKey);
  authorize.searchParams.set("redirect_uri", `${publicOrigin(context.req.raw)}/api/tiktok/callback`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", TIKTOK_SCOPES);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  return context.redirect(authorize.toString());
});

oauthRoutes.get("/tiktok/callback", async (context) => {
  const code = context.req.query("code");
  const state = context.req.query("state");
  const user = context.get("user");
  const pending = state ? await consumeOAuthState(context.env.DB, state, user.id, "tiktok") : null;
  if (!pending || !code || typeof pending.codeVerifier !== "string") return context.text("Invalid or expired OAuth state. Please try connecting again.", 400);
  const clientKey = context.env.TIKTOK_CLIENT_KEY;
  const clientSecret = context.env.TIKTOK_CLIENT_SECRET;
  if (!clientKey || !clientSecret) return context.text("TikTok is not configured on this server.", 503);

  try {
    const token = await getJson(`${TIKTOK_API}/v2/oauth/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        redirect_uri: `${publicOrigin(context.req.raw)}/api/tiktok/callback`,
        code,
        code_verifier: pending.codeVerifier,
      }),
    });
    if (!token.ok || typeof token.data.access_token !== "string") return context.text("Failed to exchange the authorization code with TikTok.", 502);

    const info = await getJson(`${TIKTOK_API}/v2/user/info/?fields=open_id,display_name,avatar_url`, {
      headers: { Authorization: `Bearer ${token.data.access_token}` },
    });
    const profile = info.data.data?.user as Record<string, any> | undefined;
    const externalId = profile?.open_id ?? token.data.open_id;
    if (typeof externalId !== "string") return context.text("Failed to fetch your TikTok profile.", 502);

    const saved = await upsertAccount(context.env.DB, {
      userId: user.id,
      platform: "tiktok",
      displayName: typeof profile?.display_name === "string" && profile.display_name ? `@${profile.display_name}` : "TikTok",
      externalId,
      accessToken: token.data.access_token,
      refreshToken: typeof token.data.refresh_token === "string" ? token.data.refresh_token : null,
      tokenExpiresAt: typeof token.data.expires_in === "number" ? Math.floor(Date.now() / 1000) + token.data.expires_in : null,
      avatarUrl: sanitizeUrl(profile?.avatar_url),
    });
    if (saved.inserted) recordConnected(context.env.DB, context.executionCtx, user.id, "tiktok", saved.id);
  } catch (error) {
    console.error(JSON.stringify({ event: "tiktok_callback_failed", error: String(error) }));
    return context.text("Could not complete the TikTok connection. Please try again.", 502);
  }
  return context.redirect("/accounts");
});

// Backs the composer's TikTok panel: who the user posts as, which privacy levels
// they may pick, and which interactions their account has disabled. Queried fresh
// each time, since TikTok's guidelines require reflecting current settings.
oauthRoutes.get("/tiktok/accounts/:id/creator-info", async (context) => {
  const id = /^\d+$/.test(context.req.param("id")) ? Number(context.req.param("id")) : null;
  if (id === null) return context.json({ error: "invalid id" }, 400);
  const row = await context.env.DB
    .prepare("SELECT id, access_token, refresh_token, token_expires_at FROM social_accounts WHERE id = ? AND user_id = ? AND platform = 'tiktok'")
    .bind(id, context.get("user").id)
    .first<{ id: number; access_token: string | null; refresh_token: string | null; token_expires_at: number | null }>();
  if (!row) return context.json({ error: "not found" }, 404);

  try {
    const token = await freshAccessToken(
      {
        accessToken: row.access_token ?? "",
        refreshToken: row.refresh_token,
        tokenExpiresAt: row.token_expires_at,
        saveTokens: async (access, refresh, expiresAt) => {
          await context.env.DB
            .prepare("UPDATE social_accounts SET access_token = ?, refresh_token = COALESCE(?, refresh_token), token_expires_at = ? WHERE id = ?")
            .bind(access, refresh, expiresAt, row.id)
            .run();
        },
      },
      tiktokRefreshRequest(context.env),
    );
    const info = await queryCreatorInfo(token);
    return context.json({
      nickname: info.creator_nickname ?? null,
      username: info.creator_username ?? null,
      avatar_url: sanitizeUrl(info.creator_avatar_url),
      privacy_level_options: info.privacy_level_options ?? [],
      comment_disabled: Boolean(info.comment_disabled),
      duet_disabled: Boolean(info.duet_disabled),
      stitch_disabled: Boolean(info.stitch_disabled),
      max_video_post_duration_sec: info.max_video_post_duration_sec ?? null,
    });
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : "TikTok creator info failed" }, 502);
  }
});
