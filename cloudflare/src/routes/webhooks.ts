import { Hono } from "hono";

import { type AppEnv, requireAuth } from "../lib/auth";
import { iso } from "./accounts";
import { DEFAULT_WEBHOOK_EVENTS, MAX_WEBHOOKS, newWebhookSecret, validWebhookUrl, WEBHOOK_EVENTS } from "../lib/webhooks";

/** /api/v1/webhooks: outbound endpoints notified about post outcomes. */
export const webhookRoutes = new Hono<AppEnv>();
webhookRoutes.use("*", requireAuth);

type Row = {
  id: number;
  url: string;
  events_json: string;
  active: number;
  created_at: number;
  last_delivery_at: number | null;
  last_delivery_status: number | null;
};

const present = (row: Row) => ({
  id: row.id,
  url: row.url,
  events: JSON.parse(row.events_json) as string[],
  active: row.active === 1,
  created_at: iso(row.created_at),
  last_delivery_at: iso(row.last_delivery_at),
  last_delivery_status: row.last_delivery_status,
});

webhookRoutes.get("/", async (context) => {
  const { results } = await context.env.DB
    .prepare("SELECT id, url, events_json, active, created_at, last_delivery_at, last_delivery_status FROM webhooks WHERE user_id = ? ORDER BY created_at, id")
    .bind(context.get("user").id)
    .all<Row>();
  return context.json(results.map(present));
});

webhookRoutes.post("/", async (context) => {
  const body: unknown = await context.req.json().catch(() => null);
  const input = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const url = validWebhookUrl(input.url);
  if (!url) {
    return context.json({ error: "validation_error", details: [{ path: "url", message: "must be a public https URL" }] }, 400);
  }
  let events: string[] = DEFAULT_WEBHOOK_EVENTS;
  if (input.events !== undefined) {
    const list = input.events;
    if (!Array.isArray(list) || list.length < 1 || list.some((event) => !(WEBHOOK_EVENTS as readonly string[]).includes(event as string))) {
      return context.json({ error: "validation_error", details: [{ path: "events", message: `one or more of ${WEBHOOK_EVENTS.join(", ")}` }] }, 400);
    }
    events = [...new Set(list as string[])];
  }

  const userId = context.get("user").id;
  const count = await context.env.DB.prepare("SELECT count(*) AS n FROM webhooks WHERE user_id = ?").bind(userId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_WEBHOOKS) {
    return context.json({ error: "limit_reached", message: `At most ${MAX_WEBHOOKS} webhooks.` }, 409);
  }

  const secret = newWebhookSecret();
  const row = await context.env.DB
    .prepare(
      `INSERT INTO webhooks (user_id, url, secret, events_json) VALUES (?, ?, ?, ?)
       RETURNING id, url, events_json, active, created_at, last_delivery_at, last_delivery_status`,
    )
    .bind(userId, url, secret, JSON.stringify(events))
    .first<Row>();
  if (!row) throw new Error("Webhook insert returned no row");
  // The signing secret is returned only here, on creation.
  return context.json({ ...present(row), secret }, 201);
});

webhookRoutes.get("/:id/deliveries", async (context) => {
  const id = Number(context.req.param("id"));
  if (!Number.isSafeInteger(id)) return context.json({ error: "invalid id" }, 400);
  const owned = await context.env.DB.prepare("SELECT 1 AS present FROM webhooks WHERE id = ? AND user_id = ?").bind(id, context.get("user").id).first();
  if (!owned) return context.json({ error: "not found" }, 404);
  const { results } = await context.env.DB
    .prepare("SELECT id, event, delivery_key, attempt, status, error, created_at FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT 50")
    .bind(id)
    .all<{ id: number; event: string; delivery_key: string; attempt: number; status: number | null; error: string | null; created_at: number }>();
  return context.json(results.map((row) => ({ ...row, created_at: iso(row.created_at) })));
});

webhookRoutes.delete("/:id", async (context) => {
  const id = Number(context.req.param("id"));
  if (!Number.isSafeInteger(id)) return context.json({ error: "invalid id" }, 400);
  const removed = await context.env.DB.prepare("DELETE FROM webhooks WHERE id = ? AND user_id = ? RETURNING id").bind(id, context.get("user").id).first();
  return removed ? context.body(null, 204) : context.json({ error: "not found" }, 404);
});
