import { hmacHex, randomBytes } from "./crypto";

export const WEBHOOK_EVENTS = ["post.published", "post.failed", "post.review_required"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
/** What a webhook subscribes to when it names no events (the Docker app's two). */
export const DEFAULT_WEBHOOK_EVENTS: WebhookEvent[] = ["post.published", "post.failed"];
export const MAX_WEBHOOKS = 10;

const DELIVERY_TIMEOUT_MS = 8000;

export function newWebhookSecret(): string {
  return `whsec_${Array.from(randomBytes(24), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** An https URL on a public-looking hostname (no IP literals, localhost or internal suffixes). */
export function validWebhookUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (host === "localhost" || host.includes(":") || /^[\d.]+$/.test(host) || !host.includes(".")) return null;
  if (/\.(local|internal|localhost|lan|home|corp)$/.test(host)) return null;
  return url.toString();
}

type Hook = { id: number; url: string; secret: string };

/** Webhook ids of the user's active endpoints subscribed to `event`. */
export async function webhookIdsFor(database: D1Database, userId: number, event: WebhookEvent): Promise<number[]> {
  const { results } = await database
    .prepare("SELECT id FROM webhooks WHERE user_id = ? AND active = 1 AND EXISTS (SELECT 1 FROM json_each(events_json) WHERE value = ?) ORDER BY id")
    .bind(userId, event)
    .all<{ id: number }>();
  return results.map((row) => row.id);
}

/**
 * One delivery attempt to one endpoint. Records the attempt and the endpoint's
 * last status, and returns whether the endpoint accepted it (2xx). Redirects
 * are not followed, so a registered URL cannot bounce the request elsewhere.
 * Secrets are read here, never passed through Workflow state.
 */
export async function deliverWebhook(
  database: D1Database,
  webhookId: number,
  event: WebhookEvent,
  data: Record<string, unknown>,
  deliveryKey: string,
  attempt: number,
): Promise<{ delivered: boolean; status: number | null }> {
  const hook = await database
    .prepare("SELECT id, url, secret FROM webhooks WHERE id = ? AND active = 1")
    .bind(webhookId)
    .first<Hook>();
  if (!hook) return { delivered: true, status: null }; // deleted or paused since: nothing to send

  const body = JSON.stringify({ event, sent_at: new Date().toISOString(), data });
  let status: number | null = null;
  let error: string | null = null;
  try {
    const response = await fetch(hook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Postfalcon-Webhooks/1",
        "X-Postfalcon-Event": event,
        "X-Postfalcon-Delivery": deliveryKey,
        "X-Postfalcon-Signature": `sha256=${await hmacHex(hook.secret, body)}`,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    status = response.status;
  } catch (caught) {
    error = (caught instanceof Error ? caught.message : String(caught)).slice(0, 300);
  }

  await database.batch([
    database
      .prepare("INSERT INTO webhook_deliveries (webhook_id, event, delivery_key, attempt, status, error) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(hook.id, event, deliveryKey, attempt, status, error),
    database.prepare("UPDATE webhooks SET last_delivery_at = unixepoch(), last_delivery_status = ? WHERE id = ?").bind(status, hook.id),
  ]);
  return { delivered: status !== null && status >= 200 && status < 300, status };
}

export async function purgeWebhookDeliveries(database: D1Database, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await database.prepare("DELETE FROM webhook_deliveries WHERE created_at < ?").bind(now - 30 * 24 * 60 * 60).run();
}

