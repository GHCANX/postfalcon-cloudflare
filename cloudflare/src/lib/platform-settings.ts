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
