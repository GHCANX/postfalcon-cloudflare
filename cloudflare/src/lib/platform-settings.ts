/**
 * The Worker's platform registry and on/off switches (platform_settings,
 * migration 0002). One file defines every platform the Worker knows: the
 * Accounts page, the admin Platforms page, the connect routes and the publish
 * path all read from here.
 *
 * "Offered" = switched on AND its secrets are set (the Docker app's
 * isPlatformOffered rule). Switched off (saved enabled = 0) also 404s the
 * platform's connect routes and fails its due posts with a clear message.
 */

export type PlatformConnect = "oauth" | "oauth-instance" | "token";

export type PlatformSetup = {
  /** Developer console URL, or null when users bring their own credentials. */
  console: string | null;
  /** Callback paths to register, joined to the public origin by the admin route. */
  callbacks: string[];
  /** Worker secret names the platform needs (never their values). */
  secrets: string[];
  /** Secrets that are nice to have but not required. */
  optionalSecrets?: string[];
  steps: string;
};

export type WorkerPlatform = {
  id: string;
  label: string;
  color: string;
  status: "live";
  connect: PlatformConnect;
  /** OAuth start path, or the token form's POST path. */
  connectPath: string | null;
  /** Every secret that must be set for the platform to be offered. */
  requiredSecrets: string[];
  setup: PlatformSetup | null;
};

export const WORKER_PLATFORMS: WorkerPlatform[] = [
  {
    id: "mastodon",
    label: "Mastodon",
    color: "#6364FF",
    status: "live",
    connect: "oauth-instance",
    connectPath: "/api/mastodon/connect",
    requiredSecrets: [],
    setup: {
      console: null,
      callbacks: [],
      secrets: [],
      steps: "Nothing to set up: Postfalcon registers itself with each Mastodon server the first time someone from it connects.",
    },
  },
  {
    id: "telegram",
    label: "Telegram",
    color: "#26A5E4",
    status: "live",
    connect: "token",
    connectPath: "/api/telegram/connect",
    requiredSecrets: [],
    setup: {
      console: null,
      callbacks: [],
      secrets: [],
      steps: "Nothing to set up: each user makes a bot with @BotFather, adds it to their channel as an admin, and pastes its token.",
    },
  },
  {
    id: "bluesky",
    label: "Bluesky",
    color: "#1185FE",
    status: "live",
    connect: "token",
    connectPath: "/api/bluesky/connect",
    requiredSecrets: [],
    setup: {
      console: null,
      callbacks: [],
      secrets: [],
      steps: "Nothing to set up: users connect with their handle and an app password from Bluesky's settings.",
    },
  },
  {
    id: "facebook",
    label: "Facebook",
    color: "#1877F2",
    status: "live",
    connect: "oauth",
    // Facebook Pages and Instagram accounts connect through the same Facebook Login flow.
    connectPath: "/api/facebook/connect",
    requiredSecrets: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"],
    setup: {
      console: "https://developers.facebook.com/apps",
      callbacks: ["/api/facebook/callback"],
      secrets: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"],
      optionalSecrets: ["FACEBOOK_CONFIG_ID"],
      steps:
        "Uses the same Meta app as Instagram: Facebook Pages you manage connect through it. Request pages_manage_posts and pages_read_engagement in App Review (or, for a Business-type app, include them in the login configuration); set the secrets with `cf workers secrets update`.",
    },
  },
  {
    id: "instagram",
    label: "Instagram",
    color: "#E1306C",
    status: "live",
    connect: "oauth",
    // Instagram professional accounts connect through the Facebook Login flow.
    connectPath: "/api/facebook/connect",
    requiredSecrets: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"],
    setup: {
      console: "https://developers.facebook.com/apps",
      callbacks: ["/api/facebook/callback"],
      secrets: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"],
      optionalSecrets: ["FACEBOOK_CONFIG_ID"],
      steps:
        "Uses one Facebook app: Instagram professional accounts linked to a Facebook Page connect through it. Create a Business-type Meta app with Facebook Login for Business and add the callback under Valid OAuth Redirect URIs; set the secrets with `cf workers secrets update`.",
    },
  },
  {
    id: "threads",
    label: "Threads",
    color: "#111111",
    status: "live",
    connect: "oauth",
    connectPath: "/api/threads/connect",
    requiredSecrets: ["THREADS_CLIENT_ID", "THREADS_CLIENT_SECRET"],
    setup: {
      console: "https://developers.facebook.com/apps",
      callbacks: ["/api/threads/callback"],
      secrets: ["THREADS_CLIENT_ID", "THREADS_CLIENT_SECRET"],
      steps:
        "A separate Meta app with the Threads use case; add the callback under Redirect Callback URLs. Other people can only connect after App Review approves threads_basic, threads_content_publish and threads_manage_insights.",
    },
  },
  {
    id: "youtube",
    label: "YouTube",
    color: "#FF0000",
    status: "live",
    connect: "oauth",
    connectPath: "/api/youtube/connect",
    requiredSecrets: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    setup: {
      console: "https://console.cloud.google.com/apis/credentials",
      callbacks: ["/api/youtube/callback"],
      secrets: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
      steps:
        "Enable the YouTube Data API v3, then create an OAuth client of type Web application with the callback. Until Google verifies the app only the test users you list can connect, and uploads are forced private until the YouTube API audit passes. Video only.",
    },
  },
  {
    id: "pinterest",
    label: "Pinterest",
    color: "#E60023",
    status: "live",
    connect: "oauth",
    connectPath: "/api/pinterest/connect",
    requiredSecrets: ["PINTEREST_APP_ID", "PINTEREST_APP_SECRET"],
    setup: {
      console: "https://developers.pinterest.com/apps/",
      callbacks: ["/api/pinterest/callback"],
      secrets: ["PINTEREST_APP_ID", "PINTEREST_APP_SECRET"],
      steps:
        "New apps get Trial access, which can only create Pins in the API sandbox; apply for Standard access to post real Pins. A Pin always needs an image. Users pick the board for their Pins on the Accounts page.",
    },
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    color: "#0A66C2",
    status: "live",
    connect: "oauth",
    connectPath: "/api/linkedin/connect",
    requiredSecrets: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
    setup: {
      console: "https://www.linkedin.com/developers/apps",
      callbacks: ["/api/linkedin/callback"],
      secrets: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
      steps:
        "The app must be linked to a LinkedIn Company Page (verify it from the app's Settings tab). Add the Sign In with LinkedIn using OpenID Connect and Share on LinkedIn products; both are approved instantly. Text posts to the personal profile only; the token lasts about 60 days with no refresh.",
    },
  },
  {
    id: "tiktok",
    label: "TikTok",
    color: "#111111",
    status: "live",
    connect: "oauth",
    connectPath: "/api/tiktok/connect",
    requiredSecrets: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
    setup: {
      console: "https://developers.tiktok.com/apps",
      callbacks: ["/api/tiktok/callback"],
      secrets: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
      steps:
        "Add Login Kit and the Content Posting API in the TikTok developer portal, then set the app's Production key and secret with `cf workers secrets update`. Posts can only be private until TikTok's Direct Post audit passes.",
    },
  },
];

const BY_ID = new Map(WORKER_PLATFORMS.map((platform) => [platform.id, platform]));

export function workerPlatform(id: string): WorkerPlatform | undefined {
  return BY_ID.get(id);
}

/** Whether a secret counts as set: present and not a placeholder (lib/config rule). */
export function secretConfigured(env: Env, name: string): boolean {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 && !value.startsWith("change-me");
}

export function platformCredentialsSet(env: Env, platform: WorkerPlatform): boolean {
  return platform.requiredSecrets.every((name) => secretConfigured(env, name));
}

/** Saved switch state: true/false when the admin set one, undefined when never touched. */
export async function platformSwitch(database: D1Database, id: string): Promise<boolean | undefined> {
  const row = await database.prepare("SELECT enabled FROM platform_settings WHERE platform = ?").bind(id).first<{ enabled: number }>();
  return row ? row.enabled === 1 : undefined;
}

/** All saved switches in one read (the Accounts page asks for every platform). */
export async function platformSwitches(database: D1Database): Promise<Map<string, boolean>> {
  const { results } = await database.prepare("SELECT platform, enabled FROM platform_settings").all<{ platform: string; enabled: number }>();
  return new Map(results.map((row) => [row.platform, row.enabled === 1]));
}

/** Switched on: the saved switch, or the default (on) when never set. */
export function platformEnabled(id: string, switches: Map<string, boolean>): boolean {
  return switches.get(id) ?? true;
}

/** Explicitly switched off — pauses publishing and 404s connect routes. */
export async function isPlatformPaused(database: D1Database, id: string): Promise<boolean> {
  return (await platformSwitch(database, id)) === false;
}

export type OfferedPlatform = WorkerPlatform & { enabled: boolean; offered: boolean };

/** Every Worker platform with its switch and credential state, for pages and the admin API. */
export async function platformStates(env: Env, database: D1Database): Promise<OfferedPlatform[]> {
  const switches = await platformSwitches(database);
  return WORKER_PLATFORMS.map((platform) => {
    const enabled = platformEnabled(platform.id, switches);
    const credentials = platformCredentialsSet(env, platform);
    return { ...platform, enabled, offered: enabled && credentials };
  });
}
