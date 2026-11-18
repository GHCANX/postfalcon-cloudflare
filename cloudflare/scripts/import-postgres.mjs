#!/usr/bin/env node
/**
 * One-time PostgreSQL (Docker app) -> D1 data import for the cutover.
 *
 *   DATABASE_URL=postgres://... node scripts/import-postgres.mjs \
 *     --media-dir ../public/uploads --out-dir ./migration-out
 *
 * Needs the `pg` package (not a dependency of this project: `npm i --no-save pg`).
 * Read-only against PostgreSQL. Writes into --out-dir:
 *   import.sql      INSERT statements, in foreign-key order, ids preserved
 *   import.batch.json  the same, as a JSON batch for `cf d1 query --batch`
 *   media.json      files to copy into R2 (key, local path, size, content type)
 *   report.json     row counts, skipped tables and every value that was altered
 *
 * Not carried over on purpose: sessions (everyone signs in again), user_tokens,
 * oauth_states, events/analytics logs, billing and invites (single-owner,
 * self-hosted profile). Run it only after the Docker scheduler is stopped.
 */
import { mkdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** [table, {pgColumn: d1Column}, columns copied as-is] in foreign-key order. */
export const TABLES = [
  ["users", {}, ["id", "email", "password_hash", "email_verified_at", "google_id", "is_admin", "stripe_customer_id", "plan", "plan_status", "plan_renews_at", "plan_cancels_at", "plan_interval", "suspended_at", "onboarding_dismissed_at", "admin_setup_dismissed_at", "created_at"]],
  ["social_accounts", { metadata: "metadata_json" }, ["id", "user_id", "platform", "display_name", "external_account_id", "access_token", "refresh_token", "token_expires_at", "avatar_url", "needs_reconnect_at", "reconnect_reason", "created_at"]],
  ["posts", { platform_options: "platform_options_json" }, ["id", "user_id", "social_account_id", "content", "status", "scheduled_for", "posted_at", "platform_post_id", "error_message", "repeat_interval", "repeat_until", "repeat_parent_id", "crosspost_group_id", "metric_views", "metric_likes", "metric_comments", "metric_shares", "metrics_updated_at", "created_at", "updated_at"]],
  ["post_media", {}, ["id", "post_id", "url", "media_type", "alt_text", "position", "created_at"]],
  ["api_tokens", {}, ["id", "user_id", "token_hash", "created_at", "last_used_at"]],
  ["mastodon_apps", {}, ["instance", "client_id", "client_secret", "created_at"]],
  ["webhooks", { events: "events_json" }, ["id", "user_id", "url", "secret", "active", "created_at", "last_delivery_at", "last_delivery_status"]],
  ["platform_settings", {}, ["platform", "enabled", "updated_at", "updated_by"]],
  ["instance_settings", { value: "value_json" }, ["key", "updated_at", "updated_by"]],
];

const JSON_COLUMNS = new Set(["metadata_json", "platform_options_json", "events_json", "value_json"]);
const CONTENT_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };

/** SQL literal for one converted value. */
export function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return value.toString();
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** One PostgreSQL value -> what D1 stores (unix seconds, 0/1, JSON text). */
export function convertValue(column, value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (JSON_COLUMNS.has(column)) return JSON.stringify(value);
  if (typeof value === "bigint") return value.toString();
  return value;
}

/**
 * One source row -> D1 row for `table`, plus a note for each change that was
 * not a plain type conversion. Returns null when the row is not carried over.
 */
export function convertRow(table, row, notes) {
  const spec = TABLES.find(([name]) => name === table);
  const [, renames, copied] = spec;
  const out = {};
  for (const column of copied) out[column] = convertValue(column, row[column]);
  for (const [from, to] of Object.entries(renames)) out[to] = convertValue(to, row[from]);

  if (table === "posts") {
    // The Docker scheduler is stopped before the export, so nothing is mid-publish;
    // a row still marked posting may or may not have gone out: never auto-retry it.
    if (out.status === "posting") {
      out.status = "review_required";
      out.review_reason = "Was mid-publish when migrated from the Docker app; check the platform before retrying.";
      notes.push(`posts.${out.id}: posting -> review_required`);
    }
  }
  if (table === "post_media" && out.media_type === "gif") {
    out.media_type = "image";
    notes.push(`post_media.${out.id}: gif -> image`);
  }
  if (table === "social_accounts" && out.metadata_json === null) out.metadata_json = "{}";
  if (table === "posts" && out.platform_options_json === null) out.platform_options_json = "{}";
  if (table === "webhooks" && out.events_json === null) out.events_json = '["post.published","post.failed"]';
  return out;
}

export function insertStatement(table, row) {
  const columns = Object.keys(row);
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((c) => literal(row[c])).join(", ")});`;
}

/** Object name inside the uploads dir for a post_media url, or null for external urls. */
export function localMediaName(url) {
  const match = /^(?:https?:\/\/[^/]+)?\/uploads\/([^/?#]+)$/.exec(url ?? "");
  return match ? decodeURIComponent(match[1]) : null;
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : fallback;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set.");
  const mediaDir = resolve(arg("media-dir", "../public/uploads"));
  const outDir = resolve(arg("out-dir", "./migration-out"));
  mkdirSync(outDir, { recursive: true });

  let pg;
  try {
    pg = (await import("pg")).default;
  } catch {
    throw new Error("The `pg` package is missing. Run: npm i --no-save pg");
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const notes = [];
  const counts = {};
  const sql = [];
  const media = new Map();
  const missingMedia = [];

  try {
    for (const [table] of TABLES) {
      const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY 1`);
      counts[table] = rows.length;
      for (const source of rows) {
        const row = convertRow(table, source, notes);
        if (table === "post_media") {
          const name = localMediaName(row.url);
          if (!name) {
            notes.push(`post_media.${row.id}: external url kept as-is, no media_file`);
          } else {
            const path = join(mediaDir, name);
            if (!existsSync(path)) {
              missingMedia.push({ post_media_id: row.id, name });
            } else {
              const contentType = CONTENT_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
              media.set(name, { key: `media/${name}`, path, byteSize: statSync(path).size, contentType, userId: source.user_id });
            }
          }
        }
        sql.push(insertStatement(table, row));
      }
    }
    // media_files rows, then point post_media at them (ids are assigned by D1).
    let fileId = 0;
    const ids = new Map();
    for (const [name, file] of media) {
      fileId += 1;
      ids.set(name, fileId);
      sql.push(insertStatement("media_files", { id: fileId, user_id: file.userId, r2_key: file.key, content_type: file.contentType, byte_size: file.byteSize }));
    }
    for (const [name, id] of ids) sql.push(`UPDATE post_media SET media_file_id = ${id} WHERE url LIKE '%/uploads/${name.replaceAll("'", "''")}';`);
  } finally {
    await pool.end();
  }

  writeFileSync(join(outDir, "import.sql"), `${sql.join("\n")}\n`);
  // For `cf d1 query <id> --batch @import.batch.json` (the statement text is too long for --sql).
  writeFileSync(join(outDir, "import.batch.json"), JSON.stringify(sql.map((statement) => ({ sql: statement }))));
  writeFileSync(join(outDir, "media.json"), JSON.stringify([...media.values()].map(({ userId, ...rest }) => rest), null, 2));
  writeFileSync(join(outDir, "report.json"), JSON.stringify({ counts, mediaFiles: media.size, missingMedia, notes }, null, 2));
  console.log(JSON.stringify({ counts, mediaFiles: media.size, missingMedia: missingMedia.length, notes: notes.length, outDir }, null, 2));
  if (missingMedia.length) console.error(`WARNING: ${missingMedia.length} media file(s) referenced by posts were not found in ${mediaDir}; see report.json.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
