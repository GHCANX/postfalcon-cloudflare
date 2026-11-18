import { type Context, Hono } from "hono";

import { type AppEnv, requireAuth } from "../lib/auth";
import { consumeOAuthState, createOAuthState, publicOrigin, sanitizeUrl } from "../lib/oauth";
import { upsertAccount } from "../lib/accounts";
import { freshAccessToken, saveAccountTokens } from "../lib/oauth-refresh";
import { base64Url, randomBytes } from "../lib/crypto";
import { GRAPH } from "../platforms/instagram";
import { queryCreatorInfo, TIKTOK_API, tiktokRefreshRequest } from "../platforms/tiktok";
import { type Board, listBoards, PINTEREST_API, PINTEREST_TOKEN_URL, pinterestBasicAuth, pinterestToken } from "../platforms/pinterest";
import { GOOGLE_TOKEN_URL } from "../platforms/youtube";
import { isPlatformPaused } from "../lib/platform-settings";

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
  if (await isPlatformPaused(context.env.DB, "mastodon")) return context.text("Not found", 404);
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
  if (await isPlatformPaused(context.env.DB, "mastodon")) return context.text("Not found", 404);
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

// --- Facebook Pages and Instagram (through Facebook Login) --------------------
// One login connects both: each Page the user manages becomes a Facebook
// account, and an Instagram business account linked to it becomes an Instagram
// account. Either can be switched off in Admin -> Platforms. Each account is
// stored with its Page access token (long-lived, no refresh).

const FACEBOOK_SCOPE = "pages_show_list,pages_manage_posts,pages_read_engagement,instagram_basic,instagram_content_publish";

async function facebookFlowSwitches(database: D1Database): Promise<{ facebook: boolean; instagram: boolean }> {
  const [facebookPaused, instagramPaused] = await Promise.all([isPlatformPaused(database, "facebook"), isPlatformPaused(database, "instagram")]);
  return { facebook: !facebookPaused, instagram: !instagramPaused };
}

oauthRoutes.get("/facebook/connect", async (context) => {
  const on = await facebookFlowSwitches(context.env.DB);
  if (!on.facebook && !on.instagram) return context.text("Not found", 404);
  const appId = context.env.FACEBOOK_APP_ID;
  if (!appId || !context.env.FACEBOOK_APP_SECRET) return context.text("Facebook is not configured on this server.", 503);
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
  const on = await facebookFlowSwitches(context.env.DB);
  if (!on.facebook && !on.instagram) return context.text("Not found", 404);
  const code = context.req.query("code");
  const state = context.req.query("state");
  const user = context.get("user");
  const pending = state ? await consumeOAuthState(context.env.DB, state, user.id, "facebook") : null;
  if (!pending || !code) return context.text("Invalid or expired OAuth state. Please try connecting again.", 400);
  const appId = context.env.FACEBOOK_APP_ID;
  const appSecret = context.env.FACEBOOK_APP_SECRET;
  if (!appId || !appSecret) return context.text("Facebook is not configured on this server.", 503);

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

    const pages = await getJson(`${GRAPH}/me/accounts?fields=id,name,access_token,picture&access_token=${encodeURIComponent(long.data.access_token)}`);
    if (!pages.ok) return context.text("Failed to fetch your Facebook Pages.", 502);
    const pageList = (Array.isArray(pages.data.data) ? pages.data.data : []) as { id: string; name: string; access_token: string; picture?: { data?: { url?: string } } }[];
    if (pageList.length === 0) return context.redirect("/accounts?error=facebook_no_pages");

    let connected = 0;
    for (const page of pageList) {
      if (on.facebook) {
        const saved = await upsertAccount(context.env.DB, {
          userId: user.id,
          platform: "facebook",
          displayName: page.name,
          externalId: page.id,
          accessToken: page.access_token,
          avatarUrl: sanitizeUrl(page.picture?.data?.url),
        });
        if (saved.inserted) recordConnected(context.env.DB, context.executionCtx, user.id, "facebook", saved.id);
        connected += 1;
      }
      if (!on.instagram) continue;
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
    return context.text("Could not complete the Facebook connection. Please try again.", 502);
  }
  return context.redirect("/accounts");
});

// --- TikTok ------------------------------------------------------------------

const TIKTOK_SCOPES = "user.info.basic,video.publish,video.upload";

oauthRoutes.get("/tiktok/connect", async (context) => {
  if (await isPlatformPaused(context.env.DB, "tiktok")) return context.text("Not found", 404);
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
  if (await isPlatformPaused(context.env.DB, "tiktok")) return context.text("Not found", 404);
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


// --- Threads -------------------------------------------------------------------
// A separate Meta app. The short-lived token is exchanged for a long-lived one
// (~60 days) which the adapter refreshes by presenting itself.

const THREADS_SCOPES = "threads_basic,threads_content_publish,threads_manage_insights";

oauthRoutes.get("/threads/connect", async (context) => {
  if (await isPlatformPaused(context.env.DB, "threads")) return context.text("Not found", 404);
  const clientId = context.env.THREADS_CLIENT_ID;
  if (!clientId || !context.env.THREADS_CLIENT_SECRET) return context.text("Threads is not configured on this server.", 503);
  const state = await createOAuthState(context.env.DB, context.get("user").id, "threads", {});
  const authorize = new URL("https://threads.net/oauth/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", `${publicOrigin(context.req.raw)}/api/threads/callback`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", THREADS_SCOPES);
  authorize.searchParams.set("state", state);
  return context.redirect(authorize.toString());
});

oauthRoutes.get("/threads/callback", async (context) => {
  if (await isPlatformPaused(context.env.DB, "threads")) return context.text("Not found", 404);
  const code = context.req.query("code");
  const state = context.req.query("state");
  const user = context.get("user");
  const pending = state ? await consumeOAuthState(context.env.DB, state, user.id, "threads") : null;
  if (!pending || !code) return context.text("Invalid or expired OAuth state. Please try connecting again.", 400);
  const clientId = context.env.THREADS_CLIENT_ID;
  const clientSecret = context.env.THREADS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return context.text("Threads is not configured on this server.", 503);

  try {
    const short = await getJson("https://graph.threads.net/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${publicOrigin(context.req.raw)}/api/threads/callback`,
        grant_type: "authorization_code",
        code,
      }),
    });
    if (!short.ok || typeof short.data.access_token !== "string") return context.text("Failed to exchange the authorization code with Threads.", 502);

    const exchange = new URL("https://graph.threads.net/access_token");
    exchange.searchParams.set("grant_type", "th_exchange_token");
    exchange.searchParams.set("client_secret", clientSecret);
    exchange.searchParams.set("access_token", short.data.access_token);
    const long = await getJson(exchange.toString());
    if (!long.ok || typeof long.data.access_token !== "string") return context.text("Failed to get a long-lived Threads token.", 502);

    const profileUrl = new URL("https://graph.threads.net/v1.0/me");
    profileUrl.searchParams.set("fields", "id,username,threads_profile_picture_url");
    profileUrl.searchParams.set("access_token", long.data.access_token);
    const profile = await getJson(profileUrl.toString());
    if (!profile.ok || typeof profile.data.id !== "string") return context.text("Failed to fetch the Threads profile.", 502);

    const saved = await upsertAccount(context.env.DB, {
      userId: user.id,
      platform: "threads",
      displayName: typeof profile.data.username === "string" ? `@${profile.data.username}` : "Threads account",
      externalId: profile.data.id,
      accessToken: long.data.access_token,
      tokenExpiresAt: typeof long.data.expires_in === "number" ? Math.floor(Date.now() / 1000) + long.data.expires_in : null,
      avatarUrl: sanitizeUrl(profile.data.threads_profile_picture_url),
    });
    if (saved.inserted) recordConnected(context.env.DB, context.executionCtx, user.id, "threads", saved.id);
  } catch (error) {
    console.error(JSON.stringify({ event: "threads_callback_failed", error: String(error) }));
    return context.text("Could not complete the Threads connection. Please try again.", 502);
  }
  return context.redirect("/accounts");
});

// --- YouTube -------------------------------------------------------------------
// Google OAuth with offline access: the refresh token is what lets scheduled
// uploads run long after the one-hour access token expires.

const YOUTUBE_SCOPES = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";

oauthRoutes.get("/youtube/connect", async (context) => {
  if (await isPlatformPaused(context.env.DB, "youtube")) return context.text("Not found", 404);
  const clientId = context.env.GOOGLE_CLIENT_ID;
  if (!clientId || !context.env.GOOGLE_CLIENT_SECRET) return context.text("YouTube is not configured on this server.", 503);
  const state = await createOAuthState(context.env.DB, context.get("user").id, "youtube", {});
  const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", `${publicOrigin(context.req.raw)}/api/youtube/callback`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", YOUTUBE_SCOPES);
  authorize.searchParams.set("access_type", "offline");
  authorize.searchParams.set("prompt", "consent");
  authorize.searchParams.set("state", state);
  return context.redirect(authorize.toString());
});

oauthRoutes.get("/youtube/callback", async (context) => {
  if (await isPlatformPaused(context.env.DB, "youtube")) return context.text("Not found", 404);
  const code = context.req.query("code");
  const state = context.req.query("state");
  const user = context.get("user");
  const pending = state ? await consumeOAuthState(context.env.DB, state, user.id, "youtube") : null;
  if (!pending || !code) return context.text("Invalid or expired OAuth state. Please try connecting again.", 400);
  const clientId = context.env.GOOGLE_CLIENT_ID;
  const clientSecret = context.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return context.text("YouTube is not configured on this server.", 503);

  try {
    const token = await getJson(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${publicOrigin(context.req.raw)}/api/youtube/callback`,
        grant_type: "authorization_code",
        code,
      }),
    });
    if (!token.ok || typeof token.data.access_token !== "string") return context.text("Failed to exchange the authorization code with Google.", 502);

    const channels = await getJson("https://www.googleapis.com/youtube/v3/channels?mine=true&part=snippet", {
      headers: { Authorization: `Bearer ${token.data.access_token}` },
    });
    const channel = (Array.isArray(channels.data.items) ? channels.data.items[0] : undefined) as Record<string, any> | undefined;
    if (!channel || typeof channel.id !== "string") return context.text("That Google account does not have a YouTube channel.", 502);

    const saved = await upsertAccount(context.env.DB, {
      userId: user.id,
      platform: "youtube",
      displayName: typeof channel.snippet?.title === "string" && channel.snippet.title ? channel.snippet.title : "YouTube channel",
      externalId: channel.id,
      accessToken: token.data.access_token,
      refreshToken: typeof token.data.refresh_token === "string" ? token.data.refresh_token : null,
      tokenExpiresAt: typeof token.data.expires_in === "number" ? Math.floor(Date.now() / 1000) + token.data.expires_in : null,
      avatarUrl: sanitizeUrl(channel.snippet?.thumbnails?.default?.url),
    });
    if (saved.inserted) recordConnected(context.env.DB, context.executionCtx, user.id, "youtube", saved.id);
  } catch (error) {
    console.error(JSON.stringify({ event: "youtube_callback_failed", error: String(error) }));
    return context.text("Could not complete the YouTube connection. Please try again.", 502);
  }
  return context.redirect("/accounts");
});

// --- LinkedIn --------------------------------------------------------------------
// Sign In with LinkedIn (OpenID Connect) + Share on LinkedIn: both open to any
// registered app. Standard apps get no refresh token; the ~60-day access token
// just expires and the account then needs reconnecting.

const LINKEDIN_SCOPES = "openid profile email w_member_social";

oauthRoutes.get("/linkedin/connect", async (context) => {
  if (await isPlatformPaused(context.env.DB, "linkedin")) return context.text("Not found", 404);
  const clientId = context.env.LINKEDIN_CLIENT_ID;
  if (!clientId || !context.env.LINKEDIN_CLIENT_SECRET) return context.text("LinkedIn is not configured on this server.", 503);
  const state = await createOAuthState(context.env.DB, context.get("user").id, "linkedin", {});
  const authorize = new URL("https://www.linkedin.com/oauth/v2/authorization");
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", `${publicOrigin(context.req.raw)}/api/linkedin/callback`);
  authorize.searchParams.set("scope", LINKEDIN_SCOPES);
  authorize.searchParams.set("state", state);
  return context.redirect(authorize.toString());
});

oauthRoutes.get("/linkedin/callback", async (context) => {
  if (await isPlatformPaused(context.env.DB, "linkedin")) return context.text("Not found", 404);
  const code = context.req.query("code");
  const state = context.req.query("state");
  const user = context.get("user");
  const pending = state ? await consumeOAuthState(context.env.DB, state, user.id, "linkedin") : null;
  // Pressing Cancel on LinkedIn's consent screen comes back with an error and nothing to store.
  if (pending && context.req.query("error")) return context.redirect("/accounts");
  if (!pending || !code) return context.text("Invalid or expired OAuth state. Please try connecting again.", 400);
  const clientId = context.env.LINKEDIN_CLIENT_ID;
  const clientSecret = context.env.LINKEDIN_CLIENT_SECRET;
  if (!clientId || !clientSecret) return context.text("LinkedIn is not configured on this server.", 503);

  try {
    const token = await getJson("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${publicOrigin(context.req.raw)}/api/linkedin/callback`,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!token.ok || typeof token.data.access_token !== "string") return context.text("Failed to exchange the authorization code with LinkedIn.", 502);

    const profile = await getJson("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${token.data.access_token}` } });
    if (typeof profile.data.sub !== "string") return context.text("LinkedIn did not return a usable profile.", 502);

    const saved = await upsertAccount(context.env.DB, {
      userId: user.id,
      platform: "linkedin",
      displayName: typeof profile.data.name === "string" && profile.data.name ? profile.data.name : "LinkedIn account",
      externalId: profile.data.sub,
      accessToken: token.data.access_token,
      tokenExpiresAt: typeof token.data.expires_in === "number" ? Math.floor(Date.now() / 1000) + token.data.expires_in : null,
      avatarUrl: sanitizeUrl(profile.data.picture),
    });
    if (saved.inserted) recordConnected(context.env.DB, context.executionCtx, user.id, "linkedin", saved.id);
  } catch (error) {
    console.error(JSON.stringify({ event: "linkedin_callback_failed", error: String(error) }));
    return context.text("Could not complete the LinkedIn connection. Please try again.", 502);
  }
  return context.redirect("/accounts");
});

// --- Pinterest -------------------------------------------------------------------
// A Pin belongs to one board, kept in the account's metadata: the first board
// at connect time (one is created for an account with none), then whatever the
// user picks on Accounts. Reconnecting keeps the choice.

const PINTEREST_SCOPES = "boards:read,boards:write,pins:read,pins:write,user_accounts:read";

oauthRoutes.get("/pinterest/connect", async (context) => {
  if (await isPlatformPaused(context.env.DB, "pinterest")) return context.text("Not found", 404);
  const appId = context.env.PINTEREST_APP_ID;
  if (!appId || !context.env.PINTEREST_APP_SECRET) return context.text("Pinterest is not configured on this server.", 503);
  const state = await createOAuthState(context.env.DB, context.get("user").id, "pinterest", {});
  const authorize = new URL("https://www.pinterest.com/oauth/");
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", appId);
  authorize.searchParams.set("redirect_uri", `${publicOrigin(context.req.raw)}/api/pinterest/callback`);
  authorize.searchParams.set("scope", PINTEREST_SCOPES);
  authorize.searchParams.set("state", state);
  return context.redirect(authorize.toString());
});

oauthRoutes.get("/pinterest/callback", async (context) => {
  if (await isPlatformPaused(context.env.DB, "pinterest")) return context.text("Not found", 404);
  const code = context.req.query("code");
  const state = context.req.query("state");
  const user = context.get("user");
  const pending = state ? await consumeOAuthState(context.env.DB, state, user.id, "pinterest") : null;
  if (!pending || !code) return context.text("Invalid or expired OAuth state. Please try connecting again.", 400);
  if (!context.env.PINTEREST_APP_ID || !context.env.PINTEREST_APP_SECRET) return context.text("Pinterest is not configured on this server.", 503);

  try {
    const token = await getJson(PINTEREST_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: pinterestBasicAuth(context.env) },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${publicOrigin(context.req.raw)}/api/pinterest/callback` }),
    });
    if (!token.ok || typeof token.data.access_token !== "string") return context.text("Failed to exchange the authorization code with Pinterest.", 502);
    const auth = { Authorization: `Bearer ${token.data.access_token}` };

    const profile = await getJson(`${PINTEREST_API}/v5/user_account`, { headers: auth });
    if (typeof profile.data.username !== "string") return context.text("Pinterest did not return a usable account profile.", 502);

    const boards = await getJson(`${PINTEREST_API}/v5/boards?page_size=1`, { headers: auth });
    const first = (Array.isArray(boards.data.items) ? boards.data.items[0] : undefined) as { id: unknown; name: string } | undefined;
    let chosen: { id: string; name: string } | null = first ? { id: String(first.id), name: first.name } : null;
    if (!chosen) {
      const created = await getJson(`${PINTEREST_API}/v5/boards`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Postfalcon", description: "Pins published with Postfalcon", privacy: "PUBLIC" }),
      });
      if (!created.ok || created.data.id === undefined) {
        return context.text("Your Pinterest account has no boards and Postfalcon could not create one. Create a board on Pinterest and try again.", 400);
      }
      chosen = { id: String(created.data.id), name: typeof created.data.name === "string" ? created.data.name : "Postfalcon" };
    }

    // A reconnect keeps the board the user already chose (and the boards found not to take Pins).
    const existing = await context.env.DB
      .prepare("SELECT metadata_json FROM social_accounts WHERE user_id = ? AND platform = 'pinterest' AND external_account_id = ?")
      .bind(user.id, profile.data.username)
      .first<{ metadata_json: string }>();
    const previous = existing ? (JSON.parse(existing.metadata_json) as Record<string, unknown>) : {};
    const metadata = previous.board_id ? previous : { board_id: chosen.id, board_name: chosen.name };

    const saved = await upsertAccount(context.env.DB, {
      userId: user.id,
      platform: "pinterest",
      displayName: profile.data.username,
      externalId: profile.data.username,
      accessToken: token.data.access_token,
      refreshToken: typeof token.data.refresh_token === "string" ? token.data.refresh_token : null,
      tokenExpiresAt: typeof token.data.expires_in === "number" ? Math.floor(Date.now() / 1000) + token.data.expires_in : null,
      metadata,
      avatarUrl: sanitizeUrl(profile.data.profile_image),
    });
    if (saved.inserted) recordConnected(context.env.DB, context.executionCtx, user.id, "pinterest", saved.id);
  } catch (error) {
    console.error(JSON.stringify({ event: "pinterest_callback_failed", error: String(error) }));
    return context.text("Could not complete the Pinterest connection. Please try again.", 502);
  }
  return context.redirect("/accounts");
});

type PinterestRow = {
  id: number;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: number | null;
  metadata_json: string;
};

/** The signed-in user's Pinterest account and its boards (for the Accounts page's board picker). */
async function pinterestBoards(context: Context<AppEnv>): Promise<{ row: PinterestRow; metadata: Record<string, any>; boards: Board[] } | Response> {
  const id = /^\d+$/.test(context.req.param("id") ?? "") ? Number(context.req.param("id")) : null;
  if (id === null) return context.json({ error: "invalid id" }, 400);
  const row = await context.env.DB
    .prepare("SELECT id, access_token, refresh_token, token_expires_at, metadata_json FROM social_accounts WHERE id = ? AND user_id = ? AND platform = 'pinterest'")
    .bind(id, context.get("user").id)
    .first<PinterestRow>();
  if (!row) return context.json({ error: "not found" }, 404);
  try {
    const token = await pinterestToken(
      {
        accessToken: row.access_token ?? "",
        refreshToken: row.refresh_token,
        tokenExpiresAt: row.token_expires_at,
        saveTokens: (access, refresh, expiresAt) => saveAccountTokens(context.env.DB, row.id, access, refresh, expiresAt),
      },
      context.env,
    );
    return { row, metadata: JSON.parse(row.metadata_json) as Record<string, any>, boards: await listBoards(token) };
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : "Pinterest boards lookup failed" }, 502);
  }
}

oauthRoutes.get("/pinterest/accounts/:id/boards", async (context) => {
  const result = await pinterestBoards(context);
  if (result instanceof Response) return result;
  const unusable = new Set<string>((result.metadata.unusable_board_ids as string[] | undefined) ?? []);
  return context.json({
    selected_board_id: result.metadata.board_id ? String(result.metadata.board_id) : null,
    boards: result.boards.map((board) => ({ ...board, usable: !unusable.has(board.id) })),
  });
});

oauthRoutes.patch("/pinterest/accounts/:id/board", async (context) => {
  const body: unknown = await context.req.json().catch(() => null);
  const boardId = body !== null && typeof body === "object" && typeof (body as Record<string, unknown>).board_id === "string" ? ((body as Record<string, string>).board_id).trim() : "";
  if (!boardId || boardId.length > 64) return context.json({ error: "board_id is required" }, 400);
  const result = await pinterestBoards(context);
  if (result instanceof Response) return result;
  const board = result.boards.find((candidate) => candidate.id === boardId);
  if (!board) return context.json({ error: "That board is not on this Pinterest account." }, 400);
  // Choosing a board by hand clears any earlier refusal of it: the user says it works now.
  const unusable = ((result.metadata.unusable_board_ids as string[] | undefined) ?? []).filter((id) => id !== board.id);
  await context.env.DB
    .prepare("UPDATE social_accounts SET metadata_json = ? WHERE id = ?")
    .bind(JSON.stringify({ ...result.metadata, board_id: board.id, board_name: board.name, unusable_board_ids: unusable }), result.row.id)
    .run();
  return context.json({ board_id: board.id, board_name: board.name });
});
