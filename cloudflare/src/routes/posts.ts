import { Hono } from "hono";

import { type AppEnv, requireAuth } from "../lib/auth";
import {
  MAX_CHANNELS_PER_POST,
  MAX_MEDIA_PER_POST,
  type MediaRow,
  type PostRow,
  REPEAT_INTERVALS,
  USER_SETTABLE_STATUSES,
  type ValidationFailure,
  parseDatetime,
  parsePlatformOptions,
  positiveIntegerList,
  serializePost,
} from "../lib/posts";

/**
 * Posts API at /api/posts and /api/v1/posts. JSON only: media is uploaded
 * first (POST /api/v1/media) and attached here by `media_ids`, instead of the
 * Docker app's multipart create. A post is one row per channel, grouped by
 * `crosspost_group_id` for cross-posts.
 */
export const postRoutes = new Hono<AppEnv>();
postRoutes.use("*", requireAuth);

const MAX_CONTENT = 10_000;
const MAX_ALT_TEXT = 1000;

function invalid(errors: ValidationFailure[]) {
  return { error: "validation_error", details: errors };
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

async function loadMedia(database: D1Database, postIds: number[]): Promise<Map<number, MediaRow[]>> {
  const byPost = new Map<number, MediaRow[]>();
  // D1 allows 100 bound parameters per statement.
  for (let start = 0; start < postIds.length; start += 90) {
    const chunk = postIds.slice(start, start + 90);
    const { results } = await database
      .prepare(
        `SELECT id, post_id, url, media_type, content_type, byte_size, alt_text, position, created_at
           FROM post_media WHERE post_id IN (${chunk.map(() => "?").join(",")}) ORDER BY position, id`,
      )
      .bind(...chunk)
      .all<MediaRow>();
    for (const row of results) byPost.set(row.post_id, [...(byPost.get(row.post_id) ?? []), row]);
  }
  return byPost;
}

async function postsWithMedia(database: D1Database, rows: PostRow[]) {
  const media = await loadMedia(database, rows.map((row) => row.id));
  return rows.map((row) => serializePost(row, media.get(row.id) ?? []));
}

function parseId(value: string): number | null {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

postRoutes.get("/", async (context) => {
  const userId = context.get("user").id;
  const where = ["posts.user_id = ?"];
  const params: unknown[] = [userId];

  const status = context.req.query("status");
  if (status) {
    const statuses = status.split(",").map((value) => value.trim()).filter(Boolean).slice(0, 20);
    if (statuses.length > 0) {
      where.push(`posts.status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
  }
  const accountId = context.req.query("social_account_id");
  if (accountId) {
    const id = parseId(accountId);
    if (id === null) return context.json({ error: "invalid social_account_id" }, 400);
    where.push("posts.social_account_id = ?");
    params.push(id);
  }

  const { results } = await context.env.DB
    .prepare(
      `SELECT posts.*, social_accounts.platform, social_accounts.display_name AS account_display_name
         FROM posts JOIN social_accounts ON social_accounts.id = posts.social_account_id
        WHERE ${where.join(" AND ")}
        ORDER BY posts.scheduled_for IS NULL, posts.scheduled_for, posts.created_at DESC, posts.id DESC`,
    )
    .bind(...params)
    .all<PostRow>();
  return context.json(await postsWithMedia(context.env.DB, results));
});

postRoutes.get("/:id", async (context) => {
  const id = parseId(context.req.param("id"));
  if (id === null) return context.json({ error: "invalid id" }, 400);
  const row = await context.env.DB
    .prepare("SELECT * FROM posts WHERE id = ? AND user_id = ?")
    .bind(id, context.get("user").id)
    .first<PostRow>();
  if (!row) return context.json({ error: "not found" }, 404);
  return context.json((await postsWithMedia(context.env.DB, [row]))[0]);
});

postRoutes.post("/", async (context) => {
  const database = context.env.DB;
  const user = context.get("user");
  const body = await jsonBody(context.req.raw);
  const errors: ValidationFailure[] = [];
  const now = Math.floor(Date.now() / 1000);

  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (content.length < 1 || content.length > MAX_CONTENT) errors.push({ path: "content", message: `1-${MAX_CONTENT} characters required` });

  const requested =
    body.social_account_ids !== undefined
      ? positiveIntegerList(body.social_account_ids, MAX_CHANNELS_PER_POST)
      : body.social_account_id !== undefined
        ? positiveIntegerList([body.social_account_id], 1)
        : null;
  if (!requested) errors.push({ path: "social_account_ids", message: "social_account_id or social_account_ids is required" });

  let scheduledFor: number | null = null;
  if (body.publish_now !== undefined && typeof body.publish_now !== "boolean") {
    errors.push({ path: "publish_now", message: "must be true or false" });
  }
  if (body.publish_now === true && body.scheduled_for) errors.push({ path: "publish_now", message: "can't be combined with scheduled_for" });
  if (body.publish_now === true) scheduledFor = now;
  else if (body.scheduled_for !== undefined) {
    scheduledFor = parseDatetime(body.scheduled_for);
    if (scheduledFor === null) errors.push({ path: "scheduled_for", message: "must be an ISO datetime" });
    else if (scheduledFor <= now) errors.push({ path: "scheduled_for", message: "must be in the future" });
  }

  let repeatInterval: string | null = null;
  if (body.repeat_interval !== undefined) {
    if (!(REPEAT_INTERVALS as readonly string[]).includes(body.repeat_interval as string)) {
      errors.push({ path: "repeat_interval", message: "must be daily, weekly or monthly" });
    } else repeatInterval = body.repeat_interval as string;
    if (scheduledFor === null) errors.push({ path: "repeat_interval", message: "repeat_interval needs a scheduled_for" });
  }
  let repeatUntil: number | null = null;
  if (body.repeat_until !== undefined) {
    repeatUntil = parseDatetime(body.repeat_until);
    if (repeatUntil === null) errors.push({ path: "repeat_until", message: "must be an ISO datetime" });
    else if (repeatUntil <= now) errors.push({ path: "repeat_until", message: "must be in the future" });
  }

  let mediaIds: number[] = [];
  if (body.media_ids !== undefined) {
    const parsed = positiveIntegerList(body.media_ids, MAX_MEDIA_PER_POST);
    if (!parsed) errors.push({ path: "media_ids", message: `1-${MAX_MEDIA_PER_POST} media ids` });
    else mediaIds = parsed;
  }
  let altTexts: unknown[] = [];
  if (body.alt_texts !== undefined) {
    if (!Array.isArray(body.alt_texts)) errors.push({ path: "alt_texts", message: "must be an array" });
    else altTexts = body.alt_texts;
  }
  const options = parsePlatformOptions(body, errors);
  if (errors.length > 0 || !requested) return context.json(invalid(errors), 400);

  // Only the owner's own accounts and media can be referenced.
  const accounts = await database
    .prepare(`SELECT id, platform FROM social_accounts WHERE user_id = ? AND id IN (${requested.map(() => "?").join(",")})`)
    .bind(user.id, ...requested)
    .all<{ id: number; platform: string }>();
  if (accounts.results.length === 0) return context.json({ error: "invalid social_account_id" }, 400);

  let files: { id: number; r2_key: string; content_type: string; byte_size: number }[] = [];
  if (mediaIds.length > 0) {
    const found = await database
      .prepare(
        `SELECT id, r2_key, content_type, byte_size FROM media_files WHERE user_id = ? AND id IN (${mediaIds.map(() => "?").join(",")})`,
      )
      .bind(user.id, ...mediaIds)
      .all<{ id: number; r2_key: string; content_type: string; byte_size: number }>();
    if (found.results.length !== mediaIds.length) return context.json(invalid([{ path: "media_ids", message: "unknown media id" }]), 400);
    const byId = new Map(found.results.map((file) => [file.id, file]));
    files = mediaIds.map((id) => byId.get(id)!);
  }

  const status = scheduledFor !== null ? "scheduled" : "draft";
  const groupId = accounts.results.length > 1 ? crypto.randomUUID() : null;
  const created: PostRow[] = [];

  for (const account of accounts.results) {
    const platformOptions = options[account.platform] ? { [account.platform]: options[account.platform] } : {};
    const post = await database
      .prepare(
        `INSERT INTO posts (user_id, social_account_id, content, status, scheduled_for, repeat_interval, repeat_until,
                            crosspost_group_id, platform_options_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .bind(user.id, account.id, content, status, scheduledFor, repeatInterval, repeatUntil, groupId, JSON.stringify(platformOptions))
      .first<PostRow>();
    if (!post) throw new Error("Post insert returned no row");

    if (files.length > 0) {
      try {
        await database.batch(
          files.map((file, position) => {
            const alt = typeof altTexts[position] === "string" ? (altTexts[position] as string).trim().slice(0, MAX_ALT_TEXT) : "";
            return database
              .prepare(
                `INSERT INTO post_media (post_id, url, media_type, content_type, byte_size, alt_text, position, media_file_id)
                 VALUES (?, ?, 'image', ?, ?, ?, ?, ?)`,
              )
              .bind(post.id, `/uploads/${file.r2_key.replace(/^media\//, "")}`, file.content_type, file.byte_size, alt || null, position, file.id);
          }),
        );
      } catch (error) {
        await database.prepare("DELETE FROM posts WHERE id = ?").bind(post.id).run();
        throw error;
      }
    }
    created.push(post);
  }

  context.executionCtx.waitUntil(
    database
      .prepare("INSERT INTO product_events (user_id, event_name, metadata_json) VALUES (?, 'post_created', ?)")
      .bind(user.id, JSON.stringify({ postId: created[0]!.id, status, channels: created.length, hasMedia: files.length > 0, repeating: Boolean(repeatInterval) }))
      .run()
      .catch(() => undefined),
  );

  const full = await postsWithMedia(database, created);
  return context.json(groupId ? { crosspost_group_id: groupId, posts: full } : full[0], 201);
});

postRoutes.patch("/:id", async (context) => {
  const database = context.env.DB;
  const user = context.get("user");
  const id = parseId(context.req.param("id"));
  if (id === null) return context.json({ error: "invalid id" }, 400);

  const body = await jsonBody(context.req.raw);
  const errors: ValidationFailure[] = [];
  const now = Math.floor(Date.now() / 1000);
  const sets: string[] = [];
  const params: unknown[] = [];
  let reschedules = false;

  if (body.publish_now !== undefined && typeof body.publish_now !== "boolean") errors.push({ path: "publish_now", message: "must be true or false" });
  const publishNow = body.publish_now === true;
  if (publishNow && body.scheduled_for) errors.push({ path: "publish_now", message: "can't be combined with scheduled_for" });
  if (publishNow && body.status !== undefined && body.status !== "scheduled") {
    errors.push({ path: "publish_now", message: "can't be combined with that status" });
  }

  if (body.content !== undefined) {
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (content.length < 1 || content.length > MAX_CONTENT) errors.push({ path: "content", message: `1-${MAX_CONTENT} characters required` });
    else {
      sets.push("content = ?");
      params.push(content);
    }
  }
  if (publishNow) {
    sets.push("status = 'scheduled'", "scheduled_for = ?");
    params.push(now);
    reschedules = true;
  } else {
    if (body.scheduled_for !== undefined) {
      if (body.scheduled_for === null) {
        sets.push("scheduled_for = NULL");
      } else {
        const when = parseDatetime(body.scheduled_for);
        if (when === null) errors.push({ path: "scheduled_for", message: "must be an ISO datetime" });
        else if (when <= now) errors.push({ path: "scheduled_for", message: "must be in the future" });
        else {
          sets.push("scheduled_for = ?");
          params.push(when);
        }
      }
      reschedules = true;
    }
    if (body.status !== undefined) {
      if (!(USER_SETTABLE_STATUSES as readonly string[]).includes(body.status as string)) {
        errors.push({ path: "status", message: `must be one of ${USER_SETTABLE_STATUSES.join(", ")}` });
      } else {
        sets.push("status = ?");
        params.push(body.status);
        reschedules = true;
      }
    }
  }
  if (body.repeat_interval !== undefined) {
    if (body.repeat_interval === null) sets.push("repeat_interval = NULL");
    else if (!(REPEAT_INTERVALS as readonly string[]).includes(body.repeat_interval as string)) errors.push({ path: "repeat_interval", message: "must be daily, weekly or monthly" });
    else {
      sets.push("repeat_interval = ?");
      params.push(body.repeat_interval);
    }
  }
  if (body.repeat_until !== undefined) {
    if (body.repeat_until === null) sets.push("repeat_until = NULL");
    else {
      const until = parseDatetime(body.repeat_until);
      if (until === null || until <= now) errors.push({ path: "repeat_until", message: "must be a future ISO datetime" });
      else {
        sets.push("repeat_until = ?");
        params.push(until);
      }
    }
  }
  const options = parsePlatformOptions(body, errors);
  if (errors.length > 0) return context.json(invalid(errors), 400);
  if (sets.length === 0 && Object.keys(options).length === 0) return context.json(invalid([{ path: "", message: "no fields to update" }]), 400);

  const current = await database
    .prepare(
      `SELECT posts.status, posts.scheduled_for, posts.platform_options_json, social_accounts.platform
         FROM posts JOIN social_accounts ON social_accounts.id = posts.social_account_id
        WHERE posts.id = ? AND posts.user_id = ?`,
    )
    .bind(id, user.id)
    .first<{ status: string; scheduled_for: number | null; platform_options_json: string; platform: string }>();
  if (!current) return context.json({ error: "not found" }, 404);
  // A post that is being sent, or already sent, must not change under the publisher.
  if (current.status === "posting" || current.status === "posted") {
    return context.json({ error: "post_locked", message: `A post that is ${current.status} can't be edited.` }, 409);
  }

  // Platform settings only apply to the post's own platform.
  const platformOptions = { ...(JSON.parse(current.platform_options_json) as Record<string, unknown>) };
  let optionsChanged = false;
  for (const [platform, value] of Object.entries(options)) {
    if (platform === current.platform) {
      platformOptions[platform] = value;
      optionsChanged = true;
    }
  }
  if (optionsChanged) {
    sets.push("platform_options_json = ?");
    params.push(JSON.stringify(platformOptions));
  }
  // Changing the time or status invalidates the Workflow instance bound to the
  // old schedule (its claim no longer matches), so the next reconciliation binds
  // a fresh one. A failed/review post going back to scheduled starts a new attempt.
  if (reschedules) sets.push("workflow_instance_id = NULL");

  // Scheduling needs a time; the final state is checked against the row, not the request.
  const finalStatus = publishNow ? "scheduled" : (body.status as string | undefined) ?? current.status;
  const finalTime = publishNow
    ? now
    : body.scheduled_for === null
      ? null
      : body.scheduled_for !== undefined
        ? parseDatetime(body.scheduled_for)
        : current.scheduled_for;
  if (finalStatus === "scheduled" && finalTime === null) {
    return context.json(invalid([{ path: "scheduled_for", message: "a scheduled post needs a scheduled_for" }]), 400);
  }

  const row = await database
    .prepare(
      `UPDATE posts SET ${sets.join(", ")}, updated_at = unixepoch()
        WHERE id = ? AND user_id = ? AND status NOT IN ('posting', 'posted') RETURNING *`,
    )
    .bind(...params, id, user.id)
    .first<PostRow>();
  // The row moved to posting between the read and the write.
  if (!row) return context.json({ error: "post_locked", message: "This post is being published and can't be edited." }, 409);

  if (body.status === "scheduled" || publishNow) {
    context.executionCtx.waitUntil(
      database
        .prepare("INSERT INTO product_events (user_id, event_name, metadata_json) VALUES (?, 'post_scheduled', ?)")
        .bind(user.id, JSON.stringify({ postId: row.id, socialAccountId: row.social_account_id }))
        .run()
        .catch(() => undefined),
    );
  }
  return context.json((await postsWithMedia(database, [row]))[0]);
});

postRoutes.delete("/:id", async (context) => {
  const id = parseId(context.req.param("id"));
  if (id === null) return context.json({ error: "invalid id" }, 400);
  const user = context.get("user");
  // A post that is mid-publish keeps its row: deleting it would hide an
  // outcome the operator may need to review. Media files are released by the
  // reference-counted sweep, not here.
  const removed = await context.env.DB
    .prepare("DELETE FROM posts WHERE id = ? AND user_id = ? AND status <> 'posting' RETURNING id")
    .bind(id, user.id)
    .first();
  if (!removed) {
    const exists = await context.env.DB.prepare("SELECT 1 AS present FROM posts WHERE id = ? AND user_id = ?").bind(id, user.id).first();
    return exists ? context.json({ error: "post_locked", message: "This post is being published and can't be deleted." }, 409) : context.json({ error: "not found" }, 404);
  }
  context.executionCtx.waitUntil(
    context.env.DB
      .prepare("INSERT INTO product_events (user_id, event_name, metadata_json) VALUES (?, 'post_deleted', ?)")
      .bind(user.id, JSON.stringify({ postId: id }))
      .run()
      .catch(() => undefined),
  );
  return context.body(null, 204);
});
