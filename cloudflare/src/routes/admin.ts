import { Hono } from "hono";

import { type AppEnv, requireAuth } from "../lib/auth";
import { ADAPTERS } from "../platforms";
import { scheduleNextOccurrence } from "../lib/recurrence";
import { iso } from "./accounts";

/**
 * Operator routes at /api/admin. Session or token auth like everything else,
 * but answers 404 to non-admins so the path is not confirmed to anyone else.
 */
export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("*", requireAuth);
adminRoutes.use("*", async (context, next) => {
  if (!context.get("user").isAdmin) return context.json({ error: "not found" }, 404);
  await next();
});

const MIB = 1024 * 1024;
const OVERDUE_SECONDS = 5 * 60;

const percent = (used: number, cap: number) => (cap > 0 ? Math.round((used / cap) * 1000) / 10 : null);

adminRoutes.get("/overview", async (context) => {
  const database = context.env.DB;
  const budget = context.env.R2_BUDGET;
  const now = Math.floor(Date.now() / 1000);

  const [lastRun, posts, reconnect, r2, migrations, owners] = await Promise.all([
    database.prepare("SELECT scheduled_for, started_at, completed_at, status, details_json FROM worker_job_runs WHERE job_name = 'reconciliation' ORDER BY id DESC LIMIT 1").first<{ scheduled_for: string; started_at: number; completed_at: number | null; status: string; details_json: string }>(),
    database
      .prepare(
        `SELECT count(*) FILTER (WHERE status = 'scheduled') AS scheduled,
                count(*) FILTER (WHERE status = 'scheduled' AND scheduled_for < ?) AS overdue,
                count(*) FILTER (WHERE status = 'posting') AS posting,
                count(*) FILTER (WHERE status = 'review_required') AS review_required,
                count(*) FILTER (WHERE status = 'failed' AND updated_at >= ?) AS failed_7d,
                count(*) FILTER (WHERE status = 'posted' AND posted_at >= ?) AS posted_7d
           FROM posts`,
      )
      .bind(now - OVERDUE_SECONDS, now - 7 * 86400, now - 7 * 86400)
      .first<Record<string, number>>(),
    database.prepare("SELECT id, platform, display_name, reconnect_reason FROM social_accounts WHERE needs_reconnect_at IS NOT NULL ORDER BY id").all<{ id: number; platform: string; display_name: string; reconnect_reason: string | null }>(),
    database.prepare("SELECT class_a_operations, class_b_operations, media_bytes, total_bytes, period_key FROM r2_budget_state WHERE singleton = 1").first<{ class_a_operations: number; class_b_operations: number; media_bytes: number; total_bytes: number; period_key: string }>(),
    database.prepare("SELECT count(*) AS applied, max(name) AS latest FROM d1_migrations").first<{ applied: number; latest: string | null }>().catch(() => null),
    database.prepare("SELECT count(*) AS n FROM users").first<{ n: number }>(),
  ]);

  const schedulerAge = lastRun ? now - lastRun.started_at : null;
  const problems: string[] = [];
  if (schedulerAge === null) problems.push("The scheduler has never run.");
  else if (schedulerAge > 5 * 60) problems.push(`The scheduler last ran ${Math.round(schedulerAge / 60)} minutes ago.`);
  if (lastRun?.status === "failed") problems.push("The last scheduler run failed.");
  if (posts!.overdue! > 0) problems.push(`${posts!.overdue} scheduled post(s) are more than 5 minutes overdue.`);
  if (posts!.posting! > 0) problems.push(`${posts!.posting} post(s) are mid-publish (stuck ones move to review after 5 minutes).`);
  if (posts!.review_required! > 0) problems.push(`${posts!.review_required} post(s) need manual review.`);
  if (reconnect.results.length > 0) problems.push(`${reconnect.results.length} account(s) need reconnecting.`);
  if (r2) {
    const worst = Math.max(percent(r2.media_bytes, budget.maxMediaBytes) ?? 0, percent(r2.total_bytes, budget.maxTotalBytes) ?? 0, percent(r2.class_a_operations, budget.maxClassAOperationsPerMonth) ?? 0, percent(r2.class_b_operations, budget.maxClassBOperationsPerMonth) ?? 0);
    if (worst >= 80) problems.push(`R2 use is at ${worst}% of a hard cap; uploads or reads stop at 100%.`);
  }
  if (owners?.n === 0) problems.push("No owner account exists yet; POST /api/setup.");

  return context.json({
    profile: context.env.APP_PROFILE,
    problems,
    scheduler: lastRun
      ? { lastRunAt: iso(lastRun.started_at), secondsAgo: schedulerAge, status: lastRun.status, details: JSON.parse(lastRun.details_json) as unknown }
      : null,
    posts,
    accountsNeedingReconnect: reconnect.results,
    r2: r2
      ? {
          period: r2.period_key,
          mediaMiB: Math.round((r2.media_bytes / MIB) * 10) / 10,
          totalMiB: Math.round((r2.total_bytes / MIB) * 10) / 10,
          classAOperations: r2.class_a_operations,
          classBOperations: r2.class_b_operations,
          caps: {
            mediaMiB: budget.maxMediaBytes / MIB,
            totalMiB: budget.maxTotalBytes / MIB,
            classAOperations: budget.maxClassAOperationsPerMonth,
            classBOperations: budget.maxClassBOperationsPerMonth,
            objectMiB: budget.maxObjectBytes / MIB,
          },
          percentOfCap: {
            media: percent(r2.media_bytes, budget.maxMediaBytes),
            total: percent(r2.total_bytes, budget.maxTotalBytes),
            classA: percent(r2.class_a_operations, budget.maxClassAOperationsPerMonth),
            classB: percent(r2.class_b_operations, budget.maxClassBOperationsPerMonth),
          },
        }
      : null,
    migrations,
    publishing: { adapters: Object.keys(ADAPTERS) },
    email: { configured: false, note: "Mailgun is not wired up yet; no failure emails are sent." },
    backups: { note: "D1 Time Travel keeps 7 days of point-in-time restore on the Free plan; scheduled R2 exports are not set up yet." },
  });
});

/** Posts that need a human: ambiguous publishes, and what the delivery audit recorded for each. */
adminRoutes.get("/review", async (context) => {
  const { results } = await context.env.DB
    .prepare(
      `SELECT posts.id, posts.content, posts.scheduled_for, posts.review_reason, posts.publish_attempts, social_accounts.platform,
              social_accounts.display_name AS account_display_name
         FROM posts JOIN social_accounts ON social_accounts.id = posts.social_account_id
        WHERE posts.status = 'review_required' ORDER BY posts.scheduled_for`,
    )
    .all<{ id: number; content: string; scheduled_for: number | null; review_reason: string | null; publish_attempts: number; platform: string; account_display_name: string }>();
  return context.json(results.map((row) => ({ ...row, scheduled_for: iso(row.scheduled_for) })));
});

/**
 * Resolves a post in review once the operator has checked the platform:
 * `retry` publishes it again (the post may then appear twice if the first
 * attempt actually went out), `mark_posted` records that it did go out,
 * `mark_failed` records that it did not.
 */
adminRoutes.post("/posts/:id/resolve", async (context) => {
  const id = Number(context.req.param("id"));
  if (!Number.isSafeInteger(id)) return context.json({ error: "invalid id" }, 400);
  const body: unknown = await context.req.json().catch(() => null);
  const input = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const action = input.action;
  if (action !== "retry" && action !== "mark_posted" && action !== "mark_failed") {
    return context.json({ error: "validation_error", details: [{ path: "action", message: "retry, mark_posted or mark_failed" }] }, 400);
  }
  const platformPostId = typeof input.platform_post_id === "string" ? input.platform_post_id.trim().slice(0, 255) || null : null;
  const database = context.env.DB;

  const sql = {
    retry: `UPDATE posts SET status = 'scheduled', scheduled_for = unixepoch(), schedule_revision = schedule_revision + 1,
                   workflow_instance_id = NULL, review_reason = NULL, error_message = NULL, updated_at = unixepoch()`,
    mark_posted: `UPDATE posts SET status = 'posted', posted_at = unixepoch(), platform_post_id = ?, review_reason = NULL,
                   error_message = NULL, updated_at = unixepoch()`,
    mark_failed: `UPDATE posts SET status = 'failed', error_message = 'Marked failed after manual review.', review_reason = NULL, updated_at = unixepoch()`,
  }[action];
  const row = await database
    .prepare(`${sql} WHERE id = ? AND status = 'review_required' RETURNING id, status`)
    .bind(...(action === "mark_posted" ? [platformPostId] : []), id)
    .first<{ id: number; status: string }>();
  if (!row) return context.json({ error: "not_in_review", message: "No post with that id is awaiting review." }, 404);

  if (action === "mark_posted") await scheduleNextOccurrence(database, id).catch(() => undefined);
  return context.json(row);
});
