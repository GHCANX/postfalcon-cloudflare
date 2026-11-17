import { Hono } from "hono";

import { type AppEnv, requireAuth } from "../lib/auth";
import { isVideoType, MEDIA_TYPES, newMediaName, parseMediaName, parseRange, UPLOAD_PART_BYTES, abortUpload, type UploadRow } from "../lib/media";
import { storeBoundedMedia, UploadRejectedError } from "../lib/r2-media";
import { R2BudgetExceededError, releaseR2StorageReservation, reserveR2Budget } from "../lib/r2-budget";

/** Authenticated upload: `POST /api/v1/media` with the raw image as the body. */
export const mediaApi = new Hono<AppEnv>();
mediaApi.use("*", requireAuth);

export type StoredImage = { id: number; url: string; content_type: string; byte_size: number };
export type StoreImageResult = { ok: true; image: StoredImage } | { ok: false; status: 400 | 413 | 415 | 507; body: Record<string, unknown> };

/** Streams one image into R2 under the budget caps and records it. Shared by the upload route and multipart post creation. */
export async function storeImage(env: AppEnv["Bindings"], userId: number, request: Request, contentTypeHeader: string): Promise<StoreImageResult> {
  const contentType = contentTypeHeader.split(";")[0]!.trim().toLowerCase();
  const name = newMediaName(contentType);
  if (!name) {
    return { ok: false, status: 415, body: { error: "unsupported_type", message: `Upload one of: ${Object.keys(MEDIA_TYPES).join(", ")}.` } };
  }

  const key = `media/${name}`;
  const budget = env.R2_BUDGET;
  let byteSize: number;
  try {
    ({ byteSize } = await storeBoundedMedia(request, env.DB, env.MEDIA, budget, { key, contentType }));
  } catch (error) {
    if (error instanceof R2BudgetExceededError) {
      const tooBig = error.dimension === "object";
      return {
        ok: false,
        status: tooBig ? 413 : 507,
        body: { error: tooBig ? "file_too_large" : "storage_limit_reached", message: tooBig ? "Files can be at most 25 MB." : "Media storage is full." },
      };
    }
    if (error instanceof UploadRejectedError) return { ok: false, status: 400, body: { error: "invalid_upload", message: error.message } };
    throw error;
  }

  try {
    const row = await env.DB
      .prepare("INSERT INTO media_files (user_id, r2_key, content_type, byte_size) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(userId, key, contentType, byteSize)
      .first<{ id: number }>();
    if (!row) throw new Error("media_files insert returned no row");
    return { ok: true, image: { id: row.id, url: `/uploads/${name}`, content_type: contentType, byte_size: byteSize } };
  } catch (error) {
    // The object exists but nothing would ever find it: remove it again.
    await reserveR2Budget(env.DB, budget, { classAOperations: 1 });
    await env.MEDIA.delete(key);
    await releaseR2StorageReservation(env.DB, { mediaBytes: byteSize, totalBytes: byteSize });
    throw error;
  }
}

mediaApi.post("/", async (context) => {
  const result = await storeImage(context.env, context.get("user").id, context.req.raw, context.req.header("content-type") ?? "");
  return result.ok ? context.json(result.image, 201) : context.json(result.body, result.status);
});

// --- Chunked uploads (R2 multipart) ----------------------------------------
// For files above the single-request limit (videos up to maxObjectBytes). The
// client creates an upload, PUTs fixed-size parts one by one, then completes it.
// Storage for the declared size is reserved up front and released on abort.

function partCount(size: number, partSize: number): number {
  return Math.ceil(size / partSize);
}

async function loadUpload(context: { env: Env; req: { param(name: string): string } }, userId: number): Promise<UploadRow | null> {
  return context.env.DB
    .prepare("SELECT * FROM media_uploads WHERE id = ? AND user_id = ?")
    .bind(context.req.param("id"), userId)
    .first<UploadRow>();
}

mediaApi.post("/uploads", async (context) => {
  const body = (await context.req.json().catch(() => null)) as { content_type?: unknown; size?: unknown } | null;
  const contentType = typeof body?.content_type === "string" ? body.content_type.split(";")[0]!.trim().toLowerCase() : "";
  const size = typeof body?.size === "number" && Number.isSafeInteger(body.size) ? body.size : 0;
  const name = newMediaName(contentType);
  if (!name) return context.json({ error: "unsupported_type", message: `Upload one of: ${Object.keys(MEDIA_TYPES).join(", ")}.` }, 415);
  if (size < 1) return context.json({ error: "invalid_upload", message: "size must be a positive integer" }, 400);

  const budget = context.env.R2_BUDGET;
  // Images stay on the single-request limit; only video may be chunked up to the object cap.
  const limit = isVideoType(contentType) ? budget.maxObjectBytes : budget.maxDirectUploadBytes;
  if (size > limit) {
    return context.json({ error: "file_too_large", message: `Files of this type can be at most ${Math.floor(limit / (1024 * 1024))} MB.` }, 413);
  }

  const key = `media/${name}`;
  try {
    await reserveR2Budget(context.env.DB, budget, { classAOperations: 1, mediaBytes: size, totalBytes: size });
  } catch (error) {
    if (error instanceof R2BudgetExceededError) return context.json({ error: "storage_limit_reached", message: "Media storage is full." }, 507);
    throw error;
  }
  let upload: R2MultipartUpload | undefined;
  try {
    upload = await context.env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType } });
    const id = crypto.randomUUID();
    await context.env.DB
      .prepare("INSERT INTO media_uploads (id, user_id, r2_key, upload_id, content_type, byte_size, part_size) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, context.get("user").id, key, upload.uploadId, contentType, size, UPLOAD_PART_BYTES)
      .run();
    return context.json({ id, part_size: UPLOAD_PART_BYTES, part_count: partCount(size, UPLOAD_PART_BYTES) }, 201);
  } catch (error) {
    // The row is what the sweep aborts. If it was never written, abort the
    // multipart here so the incomplete object is not left in the bucket.
    if (upload) {
      await reserveR2Budget(context.env.DB, budget, { classAOperations: 1 }).catch(() => undefined);
      await upload.abort().catch(() => undefined);
    }
    await releaseR2StorageReservation(context.env.DB, { mediaBytes: size, totalBytes: size });
    throw error;
  }
});

mediaApi.put("/uploads/:id/parts/:number", async (context) => {
  const userId = context.get("user").id;
  const row = await loadUpload(context, userId);
  if (!row) return context.json({ error: "not_found" }, 404);
  const number = /^\d+$/.test(context.req.param("number")) ? Number(context.req.param("number")) : 0;
  const count = partCount(row.byte_size, row.part_size);
  if (number < 1 || number > count) return context.json({ error: "invalid_part", message: `Part must be 1-${count}` }, 400);
  const expected = number === count ? row.byte_size - row.part_size * (count - 1) : row.part_size;
  const declared = Number(context.req.header("content-length"));
  if (!context.req.raw.body || declared !== expected) {
    return context.json({ error: "invalid_part", message: `Part ${number} must be exactly ${expected} bytes with a Content-Length header` }, 400);
  }

  try {
    await reserveR2Budget(context.env.DB, context.env.R2_BUDGET, { classAOperations: 1 });
  } catch (error) {
    if (error instanceof R2BudgetExceededError) return context.json({ error: "storage_limit_reached", message: "Media operations are paused by the budget guard." }, 507);
    throw error;
  }
  const resumed = context.env.MEDIA.resumeMultipartUpload(row.r2_key, row.upload_id);
  const part = await resumed.uploadPart(number, context.req.raw.body.pipeThrough(new FixedLengthStream(expected)));
  // Keep each part's etag; read-modify-write is safe because a client sends parts sequentially.
  const parts = JSON.parse(row.parts_json) as Record<string, string>;
  parts[String(number)] = part.etag;
  await context.env.DB.prepare("UPDATE media_uploads SET parts_json = ? WHERE id = ?").bind(JSON.stringify(parts), row.id).run();
  return context.json({ part: number, uploaded: Object.keys(parts).length, part_count: count });
});

mediaApi.post("/uploads/:id/complete", async (context) => {
  const userId = context.get("user").id;
  const row = await loadUpload(context, userId);
  if (!row) return context.json({ error: "not_found" }, 404);
  const count = partCount(row.byte_size, row.part_size);
  const parts = JSON.parse(row.parts_json) as Record<string, string>;
  const complete = Array.from({ length: count }, (_, index) => ({ partNumber: index + 1, etag: parts[String(index + 1)] }));
  if (complete.some((part) => !part.etag)) return context.json({ error: "incomplete", message: "Not every part has been uploaded." }, 409);

  try {
    await reserveR2Budget(context.env.DB, context.env.R2_BUDGET, { classAOperations: 1 });
    const object = await context.env.MEDIA.resumeMultipartUpload(row.r2_key, row.upload_id).complete(complete as R2UploadedPart[]);
    if (object.size !== row.byte_size) throw new Error(`Assembled size ${object.size} does not match declared ${row.byte_size}`);
  } catch (error) {
    if (error instanceof R2BudgetExceededError) return context.json({ error: "storage_limit_reached", message: "Media operations are paused by the budget guard." }, 507);
    throw error;
  }
  const [media] = await context.env.DB.batch<{ id: number }>([
    context.env.DB
      .prepare("INSERT INTO media_files (user_id, r2_key, content_type, byte_size) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(userId, row.r2_key, row.content_type, row.byte_size),
    context.env.DB.prepare("DELETE FROM media_uploads WHERE id = ?").bind(row.id),
  ]);
  const created = media!.results[0];
  if (!created) throw new Error("media_files insert returned no row");
  return context.json({ id: created.id, url: `/uploads/${row.r2_key.replace(/^media\//, "")}`, content_type: row.content_type, byte_size: row.byte_size }, 201);
});

mediaApi.delete("/uploads/:id", async (context) => {
  const row = await loadUpload(context, context.get("user").id);
  if (!row) return context.json({ error: "not_found" }, 404);
  await abortUpload(context.env, row);
  return context.body(null, 204);
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
