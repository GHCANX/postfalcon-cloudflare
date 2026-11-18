import { secretConfigured } from "./platform-settings";
import { releaseR2StorageReservation, reserveR2Budget } from "./r2-budget";

/** Copies kept in R2. With the 8 GiB total cap and 7 GiB media cap this leaves 1 GiB for them. */
export const BACKUPS_KEPT = 4;
/** A single export larger than this is refused (it would crowd out media). */
export const MAX_BACKUP_BYTES = 200 * 1024 * 1024;
/** A backup older than this (weekly cadence plus slack) raises an alert. */
export const STALE_BACKUP_SECONDS = 9 * 24 * 3600;

/**
 * Optional operator secrets: a Cloudflare API token limited to D1 edit on this
 * one database (the export endpoint is REST-only), the account id and the database id.
 */
export function backupConfigured(env: Env): boolean {
  return ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID"].every((name) => secretConfigured(env, name));
}

function exportUrl(env: Env): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID!)}/d1/database/${encodeURIComponent(env.D1_DATABASE_ID!)}/export`;
}

type ExportResponse = {
  success?: boolean;
  errors?: { message?: string }[];
  result?: ExportResult;
};
type ExportResult = {
  at_bookmark?: string;
  status?: string;
  error?: string;
  // The live API nests the download under result.result; the docs example shows it flat.
  result?: { filename?: string; signed_url?: string };
  signed_url?: string;
};

async function callExport(env: Env, body: Record<string, unknown>): Promise<ExportResponse["result"]> {
  const response = await fetch(exportUrl(env), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
    body: JSON.stringify(body),
  });
  // Never put the request (it carries the token) or raw bodies into errors.
  const parsed = (await response.json().catch(() => ({}))) as ExportResponse;
  if (!response.ok || parsed.success === false) {
    const detail = parsed.errors?.[0]?.message ?? "no detail";
    throw new Error(`D1 export API returned ${response.status}: ${detail.slice(0, 200)}`);
  }
  return parsed.result;
}

function downloadUrl(result: ExportResult | undefined): string | null {
  if (result?.status === "error") throw new Error(`D1 export failed: ${(result.error ?? "no detail").slice(0, 200)}`);
  return result?.result?.signed_url ?? result?.signed_url ?? null;
}

/** Starts an export. It often finishes at once, in which case the download URL is already there. */
export async function startExport(env: Env): Promise<{ bookmark: string; signedUrl: string | null }> {
  const result = await callExport(env, { output_format: "polling" });
  if (!result?.at_bookmark) throw new Error("D1 export API did not return a bookmark");
  return { bookmark: result.at_bookmark, signedUrl: downloadUrl(result) };
}

/** The finished export's download URL, or null while it is still being produced. */
export async function pollExport(env: Env, bookmark: string): Promise<string | null> {
  return downloadUrl(await callExport(env, { output_format: "polling", current_bookmark: bookmark }));
}

/** Downloads the dump into R2 under backups/ after reserving budget. Returns the stored key and size. */
export async function storeBackup(env: Env, signedUrl: string, now = new Date()): Promise<{ key: string; byteSize: number }> {
  const download = await fetch(signedUrl);
  if (!download.ok || !download.body) throw new Error(`Could not download the export (${download.status})`);
  const byteSize = Number(download.headers.get("content-length"));
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) throw new Error("The export download has no usable length");
  if (byteSize > MAX_BACKUP_BYTES) {
    await download.body.cancel();
    throw new Error(`The export is ${Math.round(byteSize / 1048576)} MiB, over the ${MAX_BACKUP_BYTES / 1048576} MiB backup limit`);
  }

  await reserveR2Budget(env.DB, env.R2_BUDGET, { classAOperations: 1, totalBytes: byteSize }, now);
  const key = `backups/postfalcon-d1-${now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-")}.sql`;
  try {
    const { readable, writable } = new FixedLengthStream(byteSize);
    const pipe = download.body.pipeTo(writable);
    await Promise.all([env.MEDIA.put(key, readable, { httpMetadata: { contentType: "application/sql" } }), pipe]);
  } catch (error) {
    // A failed put stores nothing, so give the storage reservation back.
    await releaseR2StorageReservation(env.DB, { totalBytes: byteSize }).catch(() => undefined);
    throw error;
  }
  await env.DB.prepare("INSERT INTO d1_backups (r2_key, byte_size) VALUES (?, ?)").bind(key, byteSize).run();
  return { key, byteSize };
}

/** Deletes copies beyond BACKUPS_KEPT, oldest first, releasing their storage once R2 confirms. */
export async function pruneBackups(env: Env): Promise<number> {
  const { results } = await env.DB
    .prepare("SELECT id, r2_key, byte_size FROM d1_backups ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?")
    .bind(BACKUPS_KEPT)
    .all<{ id: number; r2_key: string; byte_size: number }>();
  for (const row of results) {
    await reserveR2Budget(env.DB, env.R2_BUDGET, { classAOperations: 1 });
    await env.MEDIA.delete(row.r2_key);
    await releaseR2StorageReservation(env.DB, { totalBytes: row.byte_size });
    await env.DB.prepare("DELETE FROM d1_backups WHERE id = ?").bind(row.id).run();
  }
  return results.length;
}

/** Newest backup time (unix seconds), or null. */
export async function lastBackupAt(database: D1Database): Promise<number | null> {
  const row = await database.prepare("SELECT max(created_at) AS at FROM d1_backups").first<{ at: number | null }>();
  return row?.at ?? null;
}
