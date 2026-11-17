import { Hono, type Context } from "hono";

import { type AppEnv, requireAuth } from "../lib/auth";
import { ADAPTERS } from "../platforms";
import { activeAlerts, alertEmailsOn, checkAlerts } from "../lib/alerts";
import { platformCredentialsSet, platformStates, secretConfigured, workerPlatform } from "../lib/platform-settings";
import { publicOrigin } from "../lib/oauth";
import { mailConfigured, sendMail } from "../lib/mailer";
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

  const dayAgo = now - 24 * 60 * 60;
  const [lastRun, posts, reconnect, r2, migrations, owners, publishing, deliveries] = await Promise.all([
    database.prepare("SELECT scheduled_for, started_at, completed_at, status, details_json FROM worker_job_runs WHERE job_name = 'reconciliation' ORDER BY id DESC LIMIT 1").first<{ scheduled_for: string; started_at: number; completed_at: number | null; status: string; details_json: string }>(),
    database
      .prepare(
        `SELECT count(*) FILTER (WHERE status = 'scheduled') AS scheduled,
                count(*) FILTER (WHERE status = 'scheduled' AND scheduled_for < ?) AS overdue,
                count(*) FILTER (WHERE status = 'posting') AS posting,
                count(*) FILTER (WHERE status = 'review_required') AS review_required,
                count(*) FILTER (WHERE status = 'budget_hold') AS budget_hold,
                count(*) FILTER (WHERE status = 'failed' AND updated_at >= ?) AS failed_7d,
                count(*) FILTER (WHERE status = 'posted' AND posted_at >= ?) AS posted_7d,
                count(*) FILTER (WHERE status = 'draft') AS drafts
           FROM posts`,
      )
      .bind(now - OVERDUE_SECONDS, now - 7 * 86400, now - 7 * 86400)
      .first<Record<string, number>>(),
    database.prepare("SELECT id, platform, display_name, reconnect_reason, needs_reconnect_at FROM social_accounts WHERE needs_reconnect_at IS NOT NULL ORDER BY id").all<{ id: number; platform: string; display_name: string; reconnect_reason: string | null; needs_reconnect_at: number }>(),
    database.prepare("SELECT class_a_operations, class_b_operations, media_bytes, total_bytes, period_key FROM r2_budget_state WHERE singleton = 1").first<{ class_a_operations: number; class_b_operations: number; media_bytes: number; total_bytes: number; period_key: string }>(),
    database.prepare("SELECT count(*) AS applied, max(name) AS latest FROM d1_migrations").first<{ applied: number; latest: string | null }>().catch(() => null),
    database.prepare("SELECT count(*) AS n FROM users").first<{ n: number }>(),
    database
      .prepare(
        `SELECT social_accounts.platform,
                count(*) FILTER (WHERE posts.status = 'posted' AND posts.posted_at >= ?) AS posted,
                count(*) FILTER (WHERE posts.status = 'failed' AND posts.updated_at >= ?) AS failed
           FROM posts JOIN social_accounts ON social_accounts.id = posts.social_account_id
          WHERE posts.posted_at >= ? OR (posts.status = 'failed' AND posts.updated_at >= ?)
          GROUP BY social_accounts.platform ORDER BY social_accounts.platform`,
      )
      .bind(dayAgo, dayAgo, dayAgo, dayAgo)
      .all<{ platform: string; posted: number; failed: number }>(),
    // Recipient, category, status and time only — never the message body.
    database
      .prepare("SELECT recipient, category, status, error_message, created_at FROM email_deliveries ORDER BY id DESC LIMIT 8")
      .all<{ recipient: string; category: string; status: string; error_message: string | null; created_at: number }>(),
  ]);

  const schedulerAge = lastRun ? now - lastRun.started_at : null;
  const problems: string[] = [];
  if (schedulerAge === null) problems.push("The scheduler has never run.");
  else if (schedulerAge > 5 * 60) problems.push(`The scheduler last ran ${Math.round(schedulerAge / 60)} minutes ago.`);
  if (lastRun?.status === "failed") problems.push("The last scheduler run failed.");
  if (posts!.overdue! > 0) problems.push(`${posts!.overdue} scheduled post(s) are more than 5 minutes overdue.`);
  if (posts!.posting! > 0) problems.push(`${posts!.posting} post(s) are mid-publish (stuck ones move to review after 5 minutes).`);
  if (posts!.review_required! > 0) problems.push(`${posts!.review_required} post(s) need manual review.`);
  if (posts!.budget_hold! > 0) problems.push(`${posts!.budget_hold} post(s) are held because the R2 read budget is spent; they resume automatically.`);
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
    publishing: { adapters: Object.keys(ADAPTERS), byPlatform: publishing.results },
    email: {
      configured: mailConfigured(context.env),
      domain: context.env.MAILGUN_DOMAIN ?? null,
      region: context.env.MAILGUN_REGION ?? null,
      from: context.env.MAILGUN_FROM ?? null,
      note: mailConfigured(context.env)
        ? null
        : "Email is off. Workers secrets cannot be set from inside the app; set them once with `cf workers secrets update` (README “Email (Mailgun)”).",
      deliveries: deliveries.results.map((row) => ({ ...row, created_at: iso(row.created_at) })),
    },
    backups: { note: "D1 Time Travel keeps 7 days of point-in-time restore on the Free plan; scheduled R2 exports are not set up yet." },
    // The deployed Worker Version (id/timestamp), when the binding is present.
    version: context.env.VERSION_METADATA ? { id: context.env.VERSION_METADATA.id, timestamp: context.env.VERSION_METADATA.timestamp } : null,
  });
});

/** Sends one test email to prove the Mailgun settings; the admin page's Email block. */
async function sendTestEmail(context: Context<AppEnv>) {
  const user = context.get("user");
  if (!mailConfigured(context.env)) {
    return context.json({ error: "email_not_configured", message: "Email is not configured on this server." }, 503);
  }
  const body = (await context.req.json().catch(() => null)) as { to?: unknown } | null;
  const requested = typeof body?.to === "string" ? body.to.trim() : "";
  const to = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requested) ? requested.slice(0, 255) : user.email;
  const result = await sendMail(context.env, {
    to,
    userId: user.id,
    category: "test",
    subject: "Postfalcon test email",
    text: "Mailgun is set up correctly.",
  });
  const base = { from: context.env.MAILGUN_FROM ?? null, to };
  return result.status === "sent"
    ? context.json({ ...base, sent: true, response: "OK" })
    : context.json({ ...base, sent: false, response: result.error ?? "send failed", error: result.error }, 502);
}

adminRoutes.post("/test-email", sendTestEmail);
adminRoutes.post("/email/test", sendTestEmail);

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

// --- Failed posts ------------------------------------------------------------
// Overview -> Publishing: the owner's failures in a window, retried in bulk the
// same way the owner's own retry works (back to 'scheduled' with a fresh
// schedule revision so the next reconciliation binds a new Workflow instance).

const FAILED_WINDOWS: Record<string, number> = { "1": 3600, "24": 86400, "168": 7 * 86400 };
const MAX_RETRY_IDS = 500;

adminRoutes.get("/failed-posts", async (context) => {
  const hours = context.req.query("hours") ?? "24";
  const windowSeconds = FAILED_WINDOWS[hours] ?? FAILED_WINDOWS["24"]!;
  const platform = context.req.query("platform")?.slice(0, 40) || null;
  const since = Math.floor(Date.now() / 1000) - windowSeconds;
  const { results } = await context.env.DB
    .prepare(
      `SELECT posts.id, posts.updated_at, posts.error_message, social_accounts.platform,
              social_accounts.display_name, users.email
         FROM posts
         JOIN social_accounts ON social_accounts.id = posts.social_account_id
         JOIN users ON users.id = posts.user_id
        WHERE posts.status = 'failed' AND posts.updated_at > ?
          AND (? IS NULL OR social_accounts.platform = ?)
        ORDER BY posts.updated_at DESC LIMIT 500`,
    )
    .bind(since, platform, platform)
    .all<{ id: number; updated_at: number; error_message: string | null; platform: string; display_name: string; email: string }>();
  return context.json(results.map((row) => ({ ...row, updated_at: iso(row.updated_at) })));
});

adminRoutes.post("/failed-posts/retry", async (context) => {
  const body = (await context.req.json().catch(() => null)) as { ids?: unknown } | null;
  const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is number => Number.isSafeInteger(id) && (id as number) > 0).slice(0, MAX_RETRY_IDS) : [];
  if (ids.length === 0) return context.json({ error: "validation_error", details: [{ path: "ids", message: `1-${MAX_RETRY_IDS} post ids` }] }, 400);
  // json_each keeps this one statement under D1's bound-parameter limit.
  const { results } = await context.env.DB
    .prepare(
      `UPDATE posts SET status = 'scheduled', scheduled_for = unixepoch(), schedule_revision = schedule_revision + 1,
              workflow_instance_id = NULL, error_message = NULL, updated_at = unixepoch()
        WHERE status = 'failed' AND updated_at > unixepoch() - ?
          AND id IN (SELECT value FROM json_each(?))
        RETURNING id`,
    )
    .bind(7 * 86400, JSON.stringify(ids))
    .all<{ id: number }>();
  return context.json({ retried: results.map((row) => row.id) });
});

// --- Alerts ------------------------------------------------------------------
// lib/alerts.ts semantics on D1: current problems, emailed once on start, daily
// while active, once on resolve (unless instance_settings turns emails off).

adminRoutes.get("/alerts", async (context) => {
  const database = context.env.DB;
  const [alerts, emailsOn] = await Promise.all([activeAlerts(database), alertEmailsOn(database)]);
  return context.json({
    alerts: alerts.map((a) => ({ ...a, active_since: iso(a.active_since), notified_at: a.notified_at === null ? null : iso(a.notified_at) })),
    emailsOn,
    emailConfigured: mailConfigured(context.env),
  });
});

adminRoutes.post("/alerts/check", async (context) => {
  const result = await checkAlerts(context.env);
  const database = context.env.DB;
  const [alerts, emailsOn] = await Promise.all([activeAlerts(database), alertEmailsOn(database)]);
  return context.json({
    ...result,
    alerts: alerts.map((a) => ({ ...a, active_since: iso(a.active_since), notified_at: a.notified_at === null ? null : iso(a.notified_at) })),
    emailsOn,
    emailConfigured: mailConfigured(context.env),
  });
});

// --- Platforms ----------------------------------------------------------------
// On/off per platform (platform_settings). Offered = switched on AND secrets
// set; off also 404s the connect routes and fails due posts (lib/platform-settings).

adminRoutes.get("/platforms", async (context) => {
  const database = context.env.DB;
  const origin = publicOrigin(context.req.raw);
  const [states, accounts, scheduled, saved] = await Promise.all([
    platformStates(context.env, database),
    database.prepare("SELECT platform, count(*) AS n FROM social_accounts GROUP BY platform").all<{ platform: string; n: number }>(),
    database
      .prepare(
        `SELECT social_accounts.platform, count(*) AS n FROM posts
           JOIN social_accounts ON social_accounts.id = posts.social_account_id
          WHERE posts.status = 'scheduled' GROUP BY social_accounts.platform`,
      )
      .all<{ platform: string; n: number }>(),
    database.prepare("SELECT platform, updated_at FROM platform_settings").all<{ platform: string; updated_at: number }>(),
  ]);
  const accountsBy = new Map(accounts.results.map((row) => [row.platform, row.n]));
  const scheduledBy = new Map(scheduled.results.map((row) => [row.platform, row.n]));
  const savedBy = new Map(saved.results.map((row) => [row.platform, row.updated_at]));

  return context.json(
    states.map((platform) => ({
      id: platform.id,
      label: platform.label,
      built: true,
      enabled: platform.enabled,
      defaultEnabled: true,
      switchedAt: savedBy.has(platform.id) ? iso(savedBy.get(platform.id)!) : null,
      sharesConnectWith: platform.id === "instagram" ? "Facebook Login" : null,
      credentialsNeeded: platform.requiredSecrets.length ? platform.requiredSecrets.join(", ") : null,
      credentialsSet: platformCredentialsSet(context.env, platform),
      connectedAccounts: accountsBy.get(platform.id) ?? 0,
      scheduledPosts: scheduledBy.get(platform.id) ?? 0,
      setup: platform.setup
        ? {
            console: platform.setup.console,
            callbackUrls: platform.setup.callbacks.map((path) => `${origin}${path}`),
            env: [...platform.setup.secrets, ...(platform.setup.optionalSecrets ?? [])].map((name) => ({
              name,
              set: secretConfigured(context.env, name),
              optional: (platform.setup!.optionalSecrets ?? []).includes(name),
            })),
            steps: platform.setup.steps,
          }
        : null,
    })),
  );
});

adminRoutes.post("/platforms/:id", async (context) => {
  const id = context.req.param("id");
  const platform = workerPlatform(id);
  if (!platform) return context.json({ error: "not found" }, 404);
  const body = (await context.req.json().catch(() => null)) as { enabled?: unknown; reset?: unknown } | null;
  const database = context.env.DB;

  if (body?.reset === true) {
    await database.prepare("DELETE FROM platform_settings WHERE platform = ?").bind(id).run();
  } else if (typeof body?.enabled === "boolean") {
    await database
      .prepare(
        `INSERT INTO platform_settings (platform, enabled, updated_at, updated_by) VALUES (?, ?, unixepoch(), ?)
         ON CONFLICT (platform) DO UPDATE SET enabled = excluded.enabled, updated_at = unixepoch(), updated_by = excluded.updated_by`,
      )
      .bind(id, body.enabled ? 1 : 0, context.get("user").id)
      .run();
  } else {
    return context.json({ error: "validation_error", details: [{ path: "enabled", message: "enabled boolean or reset" }] }, 400);
  }

  const states = await platformStates(context.env, database);
  const state = states.find((p) => p.id === id)!;
  return context.json({ id, enabled: state.enabled, offered: state.offered });
});
