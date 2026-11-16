import { Hono } from "hono";
import type { Context } from "hono";

import { ownerExists } from "./auth";
import { type AppEnv, type AuthUser, sessionUser } from "../lib/auth";
import { mailConfigured } from "../lib/mailer";
import { adminSetupStatus, onboardingStatus } from "../lib/onboarding";
import { renderView } from "../lib/views";
import { ASSET_VERSION } from "../views/generated";

/**
 * Browser pages, rendered from the Docker app's own EJS views (precompiled by
 * scripts/build-ui.mjs). Single-owner profile: no public website, pricing,
 * signup or billing, so `/` is just the way in.
 */
export const pageRoutes = new Hono<AppEnv>();

const PLATFORMS_ON_ACCOUNTS_PAGE = ["mastodon", "bluesky", "telegram"];

function baseLocals(context: Context<AppEnv>, user: AuthUser | null): Record<string, unknown> {
  return {
    assetVersion: ASSET_VERSION,
    siteName: "Postfalcon",
    logoUrl: null,
    publicSite: false,
    blogEnabled: false,
    billingEnabled: false,
    googleSignIn: false,
    emailEnabled: mailConfigured(context.env),
    isAdmin: user?.isAdmin ?? false,
    loggedIn: user !== null,
    operatorName: null,
    operatorAbn: null,
    umamiWebsiteId: null,
    storageProvider: "r2",
    planBanner: null,
    ...(user ? { email: user.email, emailVerified: user.emailVerifiedAt !== null } : {}),
  };
}

function html(context: Context<AppEnv>, name: string, locals: Record<string, unknown>, status: 200 | 404 = 200) {
  context.header("Cache-Control", "no-store");
  return context.html(renderView(name, locals), status);
}

export function notFoundPage(context: Context<AppEnv>) {
  return html(context, "404", baseLocals(context, null), 404);
}

/** A page for signed-out visitors; the signed-in owner is sent to the app. */
function guestPage(name: string, extra: (context: Context<AppEnv>) => Record<string, unknown> = () => ({})) {
  return async (context: Context<AppEnv>) => {
    if (await sessionUser(context)) return context.redirect("/dashboard");
    return html(context, name, { ...baseLocals(context, null), ...extra(context) });
  };
}

pageRoutes.get("/", async (context) => context.redirect((await sessionUser(context)) ? "/dashboard" : "/login"));
pageRoutes.get("/login", guestPage("login"));
pageRoutes.get("/forgot-password", guestPage("forgot-password"));
pageRoutes.get("/reset-password", guestPage("reset-password", (context) => ({ token: context.req.query("token") ?? "" })));

/** First-run owner setup: only reachable while the instance has no account. */
async function setupPage(context: Context<AppEnv>) {
  if (await ownerExists(context.env.DB)) return context.redirect("/login");
  return html(context, "signup", {
    ...baseLocals(context, null),
    signupBlocked: null,
    invite: "",
    pickedPlan: null,
    livePlatforms: [],
  });
}
pageRoutes.get("/setup", setupPage);
pageRoutes.get("/signup", setupPage);

/** A page for the signed-in owner; anyone else is sent to /login. */
function appPage(name: string, extra: (context: Context<AppEnv>, user: AuthUser) => Promise<Record<string, unknown>> | Record<string, unknown> = () => ({})) {
  return async (context: Context<AppEnv>) => {
    const user = await sessionUser(context);
    if (!user) return context.redirect("/login");
    return html(context, name, { ...baseLocals(context, user), ...(await extra(context, user)) });
  };
}

pageRoutes.get(
  "/dashboard",
  appPage("dashboard", async (context, user) => ({
    onboarding: await onboardingStatus(context.env.DB, user.id),
    adminSetup: await adminSetupStatus(context.env, user.id, user.isAdmin),
  })),
);
pageRoutes.get("/analytics", appPage("analytics"));
// A platform that needs a developer app is offered once its credentials are set.
const TIKTOK_ENTRY = {
  id: "tiktok",
  label: "TikTok",
  color: "#111111",
  status: "live",
  connect: "oauth",
  connectPath: "/api/tiktok/connect",
  hint: "Connect via TikTok. Posts must have a video attached.",
};

pageRoutes.get(
  "/accounts",
  appPage("accounts", (context) => {
    const env = context.env;
    const instagram = Boolean(env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET);
    const tiktok = Boolean(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET);
    return {
      platforms: tiktok ? [TIKTOK_ENTRY] : [],
      enabledIds: [...PLATFORMS_ON_ACCOUNTS_PAGE, ...(instagram ? ["instagram"] : []), ...(tiktok ? ["tiktok"] : [])],
      lockedIds: [],
    };
  }),
);
pageRoutes.get(
  "/settings",
  appPage("settings", (_context, user) => ({
    createdAt: new Date(user.createdAt * 1000).toISOString(),
    hasPassword: user.hasPassword,
    hasGoogle: false,
  })),
);

pageRoutes.get("/robots.txt", (context) => context.text("User-agent: *\nDisallow: /\n"));
