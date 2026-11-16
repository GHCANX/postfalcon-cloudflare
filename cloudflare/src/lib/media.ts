import { releaseR2StorageReservation, reserveR2Budget, type R2Budget } from "./r2-budget";

export const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
// Video shares the image path and the same hard size caps (25 MiB per file), so only
// short clips fit. Larger files and resumable uploads are a later, separately costed step.
export const VIDEO_TYPES: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};
export const MEDIA_TYPES: Record<string, string> = { ...IMAGE_TYPES, ...VIDEO_TYPES };
const EXTENSION_TYPES = Object.fromEntries(Object.entries(MEDIA_TYPES).map(([type, ext]) => [ext, type]));

export function isVideoType(contentType: string): boolean {
  return contentType in VIDEO_TYPES;
}

/** An unreferenced object is kept this long, so an upload can be attached to a post. */
const ORPHAN_GRACE_SECONDS = 24 * 60 * 60;
const SWEEP_BATCH = 10;

export function newMediaName(contentType: string): string | null {
  const extension = MEDIA_TYPES[contentType];
  return extension ? `${crypto.randomUUID()}.${extension}` : null;
}

/** Validates a public name and maps it to its object key and content type. */
export function parseMediaName(name: string): { key: string; contentType: string } | null {
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(jpg|png|webp|gif|mp4|mov|webm)$/.exec(name);
  if (!match) return null;
  return { key: `media/${name}`, contentType: EXTENSION_TYPES[match[2]!]! };
}

/** `bytes=a-b`, `bytes=a-`, `bytes=-n` against an object of `size` bytes. */
export function parseRange(header: string, size: number): { offset: number; length: number } | "invalid" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return header.startsWith("bytes=") ? "invalid" : null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { offset: start, length: end - start + 1 };
}

/**
 * Deletes objects nothing references any more (including uploads never attached
 * to a post). Bounded per run; each delete is budgeted as a Class A operation
 * first, and storage is released only after R2 confirms the removal.
 */
export async function sweepUnreferencedMedia(
  database: D1Database,
  bucket: R2Bucket,
  budget: R2Budget,
  now = Math.floor(Date.now() / 1000),
): Promise<number> {
  const { results } = await database
    .prepare(
      `SELECT id, r2_key, byte_size FROM media_files
        WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM post_media WHERE post_media.media_file_id = media_files.id)
        ORDER BY id LIMIT ?`,
    )
    .bind(now - ORPHAN_GRACE_SECONDS, SWEEP_BATCH)
    .all<{ id: number; r2_key: string; byte_size: number }>();

  let removed = 0;
  for (const file of results) {
    // Remove the row first, and only while nothing references it. Once it is
    // gone no post can attach the file (the foreign key needs the row), so the
    // object can then be deleted without racing a new reference.
    const gone = await database
      .prepare(
        `DELETE FROM media_files WHERE id = ?
            AND NOT EXISTS (SELECT 1 FROM post_media WHERE media_file_id = ?) RETURNING id`,
      )
      .bind(file.id, file.id)
      .first();
    if (!gone) continue;

    await reserveR2Budget(database, budget, { classAOperations: 1 });
    await bucket.delete(file.r2_key);
    await releaseR2StorageReservation(database, { mediaBytes: file.byte_size, totalBytes: file.byte_size });
    removed += 1;
  }
  return removed;
}

