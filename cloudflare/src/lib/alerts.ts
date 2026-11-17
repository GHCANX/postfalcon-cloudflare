import { adminRecipients, mailConfigured, sendMail } from "./mailer";

/**
 * Operational alerts, ported from the Docker app's lib/alerts.js. checkAlerts()
 * runs from the 15-minute maintenance pass (and Overview's "Check now"): each
 * problem kind has a key in admin_alerts, announced once when it starts,
 * reminded every REMIND_SECONDS while it lasts, and reported once on resolve.
 * Emails go to every admin through Mailgun; Admin → Settings can turn them off
 * (instance_settings alert_emails = 'off'), and the problems still show on
 * Overview either way.
 */

const REMIND_SECONDS = 24 * 60 * 60;
const OVERDUE_SECONDS = 10 * 60;
const STUCK_SECONDS = 15 * 60;
const FAILURE_BURST = 5;
const ERROR_SPIKE = 20;

export type AlertProblem = { key: string; title: string; detail: string | null };

type AlertRow = { key: string; title: string; detail: string | null; active_since: number; notified_at: number | null };

async function overduePosts(database: D1Database, now: number): Promise<number> {
  const row = await database
    .prepare("SELECT count(*) AS n FROM posts WHERE status = 'scheduled' AND scheduled_for < ?")
    .bind(now - OVERDUE_SECONDS)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function stuckPosting(database: D1Database, now: number): Promise<number> {
  const row = await database
    .prepare("SELECT count(*) AS n FROM posts WHERE status = 'posting' AND updated_at < ?")
    .bind(now - STUCK_SECONDS)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function failureBursts(database: D1Database, now: number): Promise<{ platform: string; n: number }[]> {
  const { results } = await database
    .prepare(
      `SELECT social_accounts.platform, count(*) AS n
         FROM posts JOIN social_accounts ON social_accounts.id = posts.social_account_id
        WHERE posts.status = 'failed' AND posts.updated_at > ?
        GROUP BY social_accounts.platform HAVING n >= ?`,
    )
    .bind(now - 3600, FAILURE_BURST)
    .all<{ platform: string; n: number }>();
  return results;
}

async function serverErrors(database: D1Database, now: number): Promise<number> {
  const row = await database.prepare("SELECT count(*) AS n FROM server_errors WHERE created_at > ?").bind(now - 3600).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Everything wrong right now, as { key, title, detail }. */
export async function currentProblems(env: Env, now = Math.floor(Date.now() / 1000)): Promise<AlertProblem[]> {
  const database = env.DB;
  const [overdue, stuck, bursts, errors, lastRun] = await Promise.all([
    overduePosts(database, now),
    stuckPosting(database, now),
    failureBursts(database, now),
    serverErrors(database, now),
    database
      .prepare("SELECT status, started_at FROM worker_job_runs WHERE job_name = 'reconciliation' ORDER BY id DESC LIMIT 1")
      .first<{ status: string; started_at: number }>(),
  ]);

  const problems: AlertProblem[] = [];
  if (!lastRun) {
    problems.push({ key: "scheduler_never_ran", title: "The scheduler has never run", detail: "Scheduled posts will not publish. Check the Worker's cron trigger and logs." });
  } else if (lastRun.status === "failed") {
    problems.push({ key: "scheduler_error", title: "The scheduler is failing", detail: "Its last run failed. See the Worker logs and Admin → Activity." });
  }
  if (overdue > 0) {
    problems.push({
      key: "overdue_posts",
      title: `${overdue} scheduled post${overdue === 1 ? " is" : "s are"} overdue`,
      detail: `Posts are more than ${OVERDUE_SECONDS / 60} minutes past their time and haven't been sent.`,
    });
  }
  if (stuck > 0) {
    problems.push({
      key: "stuck_posting",
      title: `${stuck} post${stuck === 1 ? " has" : "s have"} been "posting" for over 15 minutes`,
      detail: "Publishing started but never finished, usually because the Worker restarted mid-send. Check whether they went out, then retry or delete them.",
    });
  }
  for (const { platform, n } of bursts) {
    problems.push({
      key: `failures_${platform}`,
      title: `${n} ${platform} posts failed in the last hour`,
      detail: "Usually the platform itself having trouble, an expired developer app, or changed API rules. Admin → Overview lists the reasons.",
    });
  }
  if (errors >= ERROR_SPIKE) {
    problems.push({ key: "server_errors", title: `${errors} server errors in the last hour`, detail: "Something is failing repeatedly. Admin → Activity has the details." });
  }
  return problems;
}

/** Alert emails are on unless instance_settings says 'off'. */
export async function alertEmailsOn(database: D1Database): Promise<boolean> {
  const row = await database
    .prepare("SELECT value_json FROM instance_settings WHERE key = 'alert_emails'")
    .first<{ value_json: string }>();
  if (!row) return true;
  try {
    return (JSON.parse(row.value_json) as unknown) !== "off";
  } catch {
    return true;
  }
}

export async function activeAlerts(database: D1Database): Promise<AlertRow[]> {
  const { results } = await database
    .prepare("SELECT key, title, detail, active_since, notified_at FROM admin_alerts WHERE resolved_at IS NULL ORDER BY active_since")
    .all<AlertRow>();
  return results;
}

function emailBody(changes: { raised: AlertProblem[]; reminded: AlertProblem[]; resolved: AlertRow[] }): string {
  const section = (heading: string, alerts: { title: string; detail?: string | null }[], withDetail: boolean) =>
    alerts.length ? `${heading}\n\n${alerts.map((a) => `- ${a.title}${withDetail && a.detail ? `\n  ${a.detail}` : ""}`).join("\n\n")}\n\n` : "";
  return (
    section("New problems:", changes.raised, true) +
    section("Still going on (reminder every 24 hours):", changes.reminded, true) +
    section("Resolved:", changes.resolved, false) +
    "Admin → Overview has the current state."
  );
}

function subjectFor(changes: { raised: AlertProblem[]; reminded: AlertProblem[]; resolved: AlertRow[] }): string {
  const active = [...changes.raised, ...changes.reminded];
  if (active.length === 1) return `Problem on Postfalcon: ${active[0]!.title}`;
  if (active.length > 1) return `${active.length} problems on Postfalcon`;
  return `Resolved on Postfalcon: ${changes.resolved.map((a) => a.title).join("; ")}`;
}

/**
 * Compares what's wrong now with what admins were last told, records the
 * difference, and emails it. Returns what happened (for "Check now" and tests).
 */
export async function checkAlerts(env: Env, now = Math.floor(Date.now() / 1000)) {
  const database = env.DB;
  const problems = await currentProblems(env, now);
  const remindBefore = now - REMIND_SECONDS;
  const active = await activeAlerts(database);
  const activeByKey = new Map(active.map((a) => [a.key, a]));
  const raised: AlertProblem[] = [];
  const reminded: AlertProblem[] = [];
  const resolved: AlertRow[] = [];

  for (const problem of problems) {
    const existing = activeByKey.get(problem.key);
    if (!existing) {
      await database
        .prepare(
          `INSERT INTO admin_alerts (key, title, detail, active_since, notified_at, resolved_at)
           VALUES (?, ?, ?, ?, NULL, NULL)
           ON CONFLICT (key) DO UPDATE SET title = excluded.title, detail = excluded.detail,
             active_since = excluded.active_since, notified_at = NULL, resolved_at = NULL`,
        )
        .bind(problem.key, problem.title, problem.detail, now)
        .run();
      raised.push(problem);
    } else {
      // Keep the wording current (e.g. the count) without restarting the alert.
      await database.prepare("UPDATE admin_alerts SET title = ?, detail = ? WHERE key = ?").bind(problem.title, problem.detail, problem.key).run();
      if (existing.notified_at === null || existing.notified_at < remindBefore) reminded.push(problem);
    }
  }
  const currentKeys = new Set(problems.map((p) => p.key));
  for (const alert of active) {
    if (currentKeys.has(alert.key)) continue;
    await database.prepare("UPDATE admin_alerts SET resolved_at = ? WHERE key = ?").bind(now, alert.key).run();
    // Only worth an email if admins were told it had started.
    if (alert.notified_at !== null) resolved.push(alert);
  }

  const changes = { raised, reminded, resolved };
  let emailedTo: string[] = [];
  if (raised.length || reminded.length || resolved.length) {
    const emailsOn = await alertEmailsOn(database);
    if (emailsOn && mailConfigured(env)) {
      const recipients = await adminRecipients(database);
      if (recipients.length) {
        emailedTo = recipients.map((r) => r.email);
        const result = await sendMail(env, {
          to: emailedTo.join(", "),
          userId: null,
          category: "admin_alert",
          subject: subjectFor(changes),
          text: emailBody(changes),
        });
        if (result.status !== "sent") {
          // Not marked as notified, so the next run tries again.
          emailedTo = [];
        }
      }
    }
    const notifiedKeys = [...raised, ...reminded].map((a) => a.key);
    if (emailedTo.length && notifiedKeys.length) {
      const stamp = now;
      await database
        .prepare(`UPDATE admin_alerts SET notified_at = ? WHERE key IN (${notifiedKeys.map(() => "?").join(",")})`)
        .bind(stamp, ...notifiedKeys)
        .run();
    }
  }
  return { raised: raised.map((a) => a.key), reminded: reminded.map((a) => a.key), resolved: resolved.map((a) => a.key), emailedTo };
}

