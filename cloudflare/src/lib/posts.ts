import { iso } from "../routes/accounts";

export const USER_SETTABLE_STATUSES = ["draft", "scheduled", "canceled"] as const;
export const REPEAT_INTERVALS = ["daily", "weekly", "monthly"] as const;
export const MAX_MEDIA_PER_POST = 10;
export const MAX_CHANNELS_PER_POST = 30;

export type PostRow = {
  id: number;
  user_id: number;
  social_account_id: number;
  content: string;
  status: string;
  scheduled_for: number | null;
  posted_at: number | null;
  platform_post_id: string | null;
  error_message: string | null;
  repeat_interval: string | null;
  repeat_until: number | null;
  repeat_parent_id: number | null;
  crosspost_group_id: string | null;
  platform_options_json: string;
  metric_views: number | null;
  metric_likes: number | null;
  metric_comments: number | null;
  metric_shares: number | null;
  metrics_updated_at: number | null;
  review_reason: string | null;
  created_at: number;
  updated_at: number;
  platform?: string;
  account_display_name?: string;
};

export type MediaRow = {
  id: number;
  post_id: number;
  url: string;
  media_type: string;
  content_type: string | null;
  byte_size: number | null;
  alt_text: string | null;
  position: number;
  created_at: number;
};

export function serializePost(row: PostRow, media: MediaRow[]) {
  // Internal delivery bookkeeping (lease, workflow id) is never exposed.
  return {
    id: row.id,
    user_id: row.user_id,
    social_account_id: row.social_account_id,
    ...(row.platform !== undefined ? { platform: row.platform, account_display_name: row.account_display_name } : {}),
    content: row.content,
    status: row.status,
    scheduled_for: iso(row.scheduled_for),
    posted_at: iso(row.posted_at),
    platform_post_id: row.platform_post_id,
    error_message: row.error_message,
    review_reason: row.review_reason,
    repeat_interval: row.repeat_interval,
    repeat_until: iso(row.repeat_until),
    repeat_parent_id: row.repeat_parent_id,
    crosspost_group_id: row.crosspost_group_id,
    platform_options: JSON.parse(row.platform_options_json) as Record<string, unknown>,
    metric_views: row.metric_views,
    metric_likes: row.metric_likes,
    metric_comments: row.metric_comments,
    metric_shares: row.metric_shares,
    metrics_updated_at: iso(row.metrics_updated_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    media: media.map((item) => ({
      id: item.id,
      url: item.url,
      media_type: item.media_type,
      content_type: item.content_type,
      byte_size: item.byte_size,
      alt_text: item.alt_text,
      position: item.position,
    })),
  };
}

export type ValidationFailure = { path: string; message: string };

/** Parses an ISO datetime to Unix seconds; null when it is not one. */
export function parseDatetime(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export function positiveIntegerList(value: unknown, max: number): number[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) return null;
  const ids = value.map((item) => (typeof item === "number" ? item : typeof item === "string" && /^\d+$/.test(item) ? Number(item) : NaN));
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) return null;
  return [...new Set(ids)];
}

const TIKTOK_PRIVACY = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"];
const YOUTUBE_PRIVACY = ["public", "unlisted", "private"];

function flag(value: unknown, path: string, errors: ValidationFailure[]): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") errors.push({ path, message: "must be true or false" });
  return value === true;
}

/** Per-platform composer settings, validated the way the Docker schemas do. */
export function parsePlatformOptions(
  body: Record<string, unknown>,
  errors: ValidationFailure[],
): Record<string, Record<string, unknown>> {
  const options: Record<string, Record<string, unknown>> = {};

  if (body.tiktok_options !== undefined) {
    const raw = body.tiktok_options;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push({ path: "tiktok_options", message: "must be an object" });
    } else {
      const input = raw as Record<string, unknown>;
      const privacy = input.privacy_level;
      if (privacy !== undefined && !TIKTOK_PRIVACY.includes(privacy as string)) {
        errors.push({ path: "tiktok_options.privacy_level", message: "invalid privacy level" });
      }
      const brandContent = flag(input.brand_content, "tiktok_options.brand_content", errors);
      if (brandContent && privacy === "SELF_ONLY") {
        errors.push({ path: "tiktok_options", message: "branded content cannot be private" });
      }
      options.tiktok = {
        ...(typeof privacy === "string" ? { privacy_level: privacy } : {}),
        allow_comment: flag(input.allow_comment, "tiktok_options.allow_comment", errors),
        allow_duet: flag(input.allow_duet, "tiktok_options.allow_duet", errors),
        allow_stitch: flag(input.allow_stitch, "tiktok_options.allow_stitch", errors),
        brand_organic: flag(input.brand_organic, "tiktok_options.brand_organic", errors),
        brand_content: brandContent,
      };
    }
  }

  if (body.youtube_options !== undefined) {
    const raw = body.youtube_options;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push({ path: "youtube_options", message: "must be an object" });
    } else {
      const input = raw as Record<string, unknown>;
      const title = typeof input.title === "string" ? input.title.trim() : undefined;
      if (input.title !== undefined && (!title || title.length > 100 || /[<>]/.test(title))) {
        errors.push({ path: "youtube_options.title", message: "1-100 characters, no < or >" });
      }
      if (input.privacy_status !== undefined && !YOUTUBE_PRIVACY.includes(input.privacy_status as string)) {
        errors.push({ path: "youtube_options.privacy_status", message: "invalid privacy status" });
      }
      options.youtube = {
        ...(title ? { title } : {}),
        ...(typeof input.privacy_status === "string" ? { privacy_status: input.privacy_status } : {}),
        made_for_kids: flag(input.made_for_kids, "youtube_options.made_for_kids", errors),
      };
    }
  }
  return options;
}
