import { Hono } from "hono";
import type { Context } from "hono";

import { ownerExists } from "./auth";
import { type AppEnv, type AuthUser, sessionUser } from "../lib/auth";
import { mailConfigured } from "../lib/mailer";
import { adminSetupStatus, onboardingStatus } from "../lib/onboarding";
import { platformStates } from "../lib/platform-settings";
import { renderView } from "../lib/views";
import { ASSET_VERSION } from "../views/generated";

/**
 * Browser pages, rendered from the Docker app's own EJS views (precompiled by
 * scripts/build-ui.mjs). Single-owner profile: no public website, pricing,
 * signup or billing, so `/` is just the way in.
 */
export const pageRoutes = new Hono<AppEnv>();

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
/** A page for the signed-in owner who is also an admin; everyone else is redirected. */
function adminPage(name: string, extra: (context: Context<AppEnv>, user: AuthUser) => Promise<Record<string, unknown>> | Record<string, unknown> = () => ({})) {
  return async (context: Context<AppEnv>) => {
    const user = await sessionUser(context);
    if (!user) return context.redirect("/login");
    if (!user.isAdmin) return context.redirect("/dashboard");
    return html(context, name, { ...baseLocals(context, user), ...(await extra(context, user)) });
  };
}

pageRoutes.get("/admin", (context) => context.redirect("/admin/overview"));
pageRoutes.get("/admin/overview", adminPage("admin-overview"));
pageRoutes.get("/admin/platforms", adminPage("admin-platforms"));
pageRoutes.get("/analytics", appPage("analytics"));

pageRoutes.get(
  "/accounts",
  appPage("accounts", async (context) => {
    // Offered = switched on in Admin → Platforms AND its secrets are set.
    // Hand-built connect blocks cover mastodon/instagram/telegram/bluesky;
    // the `platforms` list only needs the OAuth entries rendered generically
    // (today: TikTok). Instagram stays out of it — the view links it to the
    // Facebook flow itself.
    const states = await platformStates(context.env, context.env.DB);
    const offered = states.filter((p) => p.offered);
    return {
      platforms: offered
        .filter((p) => p.connect === "oauth" && p.connectPath && p.id !== "instagram")
        .map((p) => ({ id: p.id, label: p.label, color: p.color, status: p.status, connect: p.connect, connectPath: p.connectPath, hint: p.setup?.steps ?? null })),
      enabledIds: offered.map((p) => p.id),
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
