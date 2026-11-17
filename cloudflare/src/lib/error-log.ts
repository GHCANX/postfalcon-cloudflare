// Port of lib/errorLog.js: keeps error-level failures in server_errors for
// Admin -> Activity. Best effort by design — fire-and-forget, capped per
// minute so an error storm can't become a database storm, and a failure here
// is swallowed rather than logged (logging it would feed straight back in).

const MAX_PER_MINUTE = 60;
const KEEP_DAYS = 30;
let windowStart = 0;
let windowCount = 0;

function clip(value: unknown, max: number): string | null {
  if (value == null) return null;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function recordServerError(
  database: D1Database,
  entry: { message?: unknown; err?: unknown; method?: unknown; url?: unknown },
): void {
  const now = Date.now();
  if (now - windowStart > 60000) {
    windowStart = now;
    windowCount = 0;
  }
  if (++windowCount > MAX_PER_MINUTE) return;

  const err = entry.err as { name?: string; type?: string; message?: string; stack?: string } | undefined;
  void database
    .prepare(
      `INSERT INTO server_errors (message, error_type, error_message, stack, method, url)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      clip(entry.message ?? err?.message, 500),
      clip(err?.name ?? err?.type, 100),
      clip(err?.message, 2000),
      clip(err?.stack, 8000),
      clip(entry.method, 10),
      clip(entry.url, 500),
    )
    .run()
    .catch(() => undefined);
}

export async function listServerErrors(database: D1Database, limit = 100) {
  const result = await database
    .prepare(
      `SELECT id, created_at, message, error_type, error_message, stack, method, url
       FROM server_errors ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all();
  return result.results;
}

export async function pruneServerErrors(database: D1Database): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - KEEP_DAYS * 86400;
  const result = await database.prepare("DELETE FROM server_errors WHERE created_at < ?").bind(cutoff).run();
  return result.meta.changes ?? 0;
}

/** Convenience for request handlers: log an error and record it for Activity. */
export function recordRequestError(env: Env, error: unknown, method: string, url: string): void {
  recordServerError(env.DB, {
    message: "unhandled_request_error",
    err: error,
    method,
    url,
  });
}
