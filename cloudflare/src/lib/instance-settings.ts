// Port of lib/instanceSettings.js for D1. instance_settings stores one
// JSON-encoded value per key. The Worker profile has no public site, logo
// upload, sign-up modes or invites, so only site_name and alert_emails are
// supported here.

export const DEFAULT_SITE_NAME = "Postfalcon";

export type InstanceSettings = {
  siteName: string;
  alertEmails: boolean;
};

export async function readInstanceSettings(database: D1Database): Promise<Record<string, unknown>> {
  const result = await database.prepare("SELECT key, value_json FROM instance_settings").all<{ key: string; value_json: string }>();
  const stored: Record<string, unknown> = {};
  for (const row of result.results) {
    try {
      stored[row.key] = JSON.parse(row.value_json);
    } catch {
      // A hand-edited row shouldn't take pages down.
    }
  }
  return stored;
}

export function resolveSettings(stored: Record<string, unknown>): InstanceSettings {
  const siteName = typeof stored.site_name === "string" && stored.site_name.trim() ? stored.site_name.trim().slice(0, 40) : DEFAULT_SITE_NAME;
  return { siteName, alertEmails: stored.alert_emails !== "off" };
}

export async function saveInstanceSetting(database: D1Database, key: string, value: unknown, userId: number): Promise<void> {
  await database
    .prepare(
      `INSERT INTO instance_settings (key, value_json, updated_at, updated_by) VALUES (?, ?, unixepoch(), ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = unixepoch(), updated_by = excluded.updated_by`,
    )
    .bind(key, JSON.stringify(value), userId)
    .run();
}

export async function clearInstanceSetting(database: D1Database, key: string): Promise<void> {
  await database.prepare("DELETE FROM instance_settings WHERE key = ?").bind(key).run();
}
