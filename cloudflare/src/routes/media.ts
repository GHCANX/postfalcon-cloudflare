import { Hono } from "hono";

import { type AppEnv, requireAuth } from "../lib/auth";
import { IMAGE_TYPES, newMediaName, parseMediaName, parseRange } from "../lib/media";
import { storeBoundedMedia, UploadRejectedError } from "../lib/r2-media";
import { R2BudgetExceededError, releaseR2StorageReservation, reserveR2Budget } from "../lib/r2-budget";

/** Authenticated upload: `POST /api/v1/media` with the raw image as the body. */
export const mediaApi = new Hono<AppEnv>();
mediaApi.use("*", requireAuth);

mediaApi.post("/", async (context) => {
  const contentType = (context.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const name = newMediaName(contentType);
  if (!name) {
    return context.json({ error: "unsupported_type", message: `Upload a ${Object.keys(IMAGE_TYPES).join(", ")} image.` }, 415);
  }

  const key = `media/${name}`;
  const budget = context.env.R2_BUDGET;
  let byteSize: number;
  try {
    ({ byteSize } = await storeBoundedMedia(context.req.raw, context.env.DB, context.env.MEDIA, budget, { key, contentType }));
  } catch (error) {
    if (error instanceof R2BudgetExceededError) {
      const tooBig = error.dimension === "object";
      return context.json(
        { error: tooBig ? "file_too_large" : "storage_limit_reached", message: tooBig ? "Images can be at most 25 MB." : "Media storage is full." },
        tooBig ? 413 : 507,
      );
    }
    if (error instanceof UploadRejectedError) return context.json({ error: "invalid_upload", message: error.message }, 400);
    throw error;
  }

  try {
    const row = await context.env.DB
      .prepare("INSERT INTO media_files (user_id, r2_key, content_type, byte_size) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(context.get("user").id, key, contentType, byteSize)
      .first<{ id: number }>();
    if (!row) throw new Error("media_files insert returned no row");
    return context.json({ id: row.id, url: `/uploads/${name}`, content_type: contentType, byte_size: byteSize }, 201);
  } catch (error) {
    // The object exists but nothing would ever find it: remove it again.
    await reserveR2Budget(context.env.DB, budget, { classAOperations: 1 });
    await context.env.MEDIA.delete(key);
    await releaseR2StorageReservation(context.env.DB, { mediaBytes: byteSize, totalBytes: byteSize });
    throw error;
  }
});

/**
 * Public read of `/uploads/<uuid>.<ext>`: social platforms fetch these URLs
 * without a session, and the unguessable names are the only access control,
 * as in the Docker app. Each read is budgeted as one Class B operation.
 */
export const publicMedia = new Hono<AppEnv>();

publicMedia.on(["GET", "HEAD"], "/:name", async (context) => {
  const parsed = parseMediaName(context.req.param("name"));
  if (!parsed) return context.json({ error: "not_found" }, 404);

  const known = await context.env.DB
    .prepare("SELECT byte_size FROM media_files WHERE r2_key = ?")
    .bind(parsed.key)
    .first<{ byte_size: number }>();
  if (!known) return context.json({ error: "not_found" }, 404);

  const rangeHeader = context.req.header("range");
  const range = rangeHeader ? parseRange(rangeHeader, known.byte_size) : null;
  if (range === "invalid") {
    context.header("Content-Range", `bytes */${known.byte_size}`);
    return context.body(null, 416);
  }

  try {
    await reserveR2Budget(context.env.DB, context.env.R2_BUDGET, { classBOperations: 1 });
  } catch (error) {
    if (error instanceof R2BudgetExceededError) return context.json({ error: "unavailable" }, 503);
    throw error;
  }

  const object = await context.env.MEDIA.get(parsed.key, range ? { range } : undefined);
  if (!object) return context.json({ error: "not_found" }, 404);

  const headers = new Headers({
    "Content-Type": parsed.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=604800, immutable",
    ETag: object.httpEtag,
    "Content-Disposition": "inline",
  });
  if (range) {
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${known.byte_size}`);
    headers.set("Content-Length", String(range.length));
  } else {
    headers.set("Content-Length", String(known.byte_size));
  }
  const status = range ? 206 : 200;
  return new Response(context.req.method === "HEAD" ? null : (object as R2ObjectBody).body, { status, headers });
});
