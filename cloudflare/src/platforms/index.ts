import { bluesky } from "./bluesky";
import { instagram } from "./instagram";
import { mastodon } from "./mastodon";
import { telegram } from "./telegram";
import { tiktok } from "./tiktok";
import type { PlatformAdapter } from "./types";

/** Platforms with a Worker publish adapter. Others stay in manual review. */
export const ADAPTERS: Record<string, PlatformAdapter> = { mastodon, telegram, bluesky, instagram, tiktok };
