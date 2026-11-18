import { bluesky } from "./bluesky";
import { facebook } from "./facebook";
import { instagram } from "./instagram";
import { mastodon } from "./mastodon";
import { linkedin } from "./linkedin";
import { pinterest } from "./pinterest";
import { telegram } from "./telegram";
import { threads } from "./threads";
import { tiktok } from "./tiktok";
import type { PlatformAdapter } from "./types";
import { youtube } from "./youtube";

/** Platforms with a Worker publish adapter. Others stay in manual review. */
export const ADAPTERS: Record<string, PlatformAdapter> = {
  mastodon,
  telegram,
  bluesky,
  facebook,
  instagram,
  threads,
  youtube,
  pinterest,
  linkedin,
  tiktok,
};
