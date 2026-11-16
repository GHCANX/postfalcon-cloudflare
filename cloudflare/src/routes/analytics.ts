import { Hono } from "hono";

import { type AppEnv, requireAuth } from "../lib/auth";
import { iso } from "./accounts";

/** /api/v1/analytics/summary: aggregates the metric_* columns the metrics job keeps fresh. */
export const analyticsRoutes = new Hono<AppEnv>();
analyticsRoutes.use("*", requireAuth);

const RANGES = [7, 30, 90];
const POSTS_LISTED = 20;
const DAY = 24 * 60 * 60;

function resolveTimeZone(tz: string | undefined): string {
  if (!tz || tz.length > 64) return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** YYYY-MM-DD of a Unix time on the calendar of `tz`. */
function dayKey(seconds: number, formatter: Intl.DateTimeFormat): string {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(seconds * 1000)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

type Metric = number | null;
const sum = (values: Metric[]): Metric => (values.some((value) => value !== null) ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : null);

type PostedRow = {
  id: number;
  content: string;
  posted_at: number;
  platform: string;
  account_display_name: string;
  metric_views: Metric;
  metric_likes: Metric;
  metric_comments: Metric;
  metric_shares: Metric;
};

analyticsRoutes.get("/summary", async (context) => {
  const database = context.env.DB;
  const userId = context.get("user").id;
  const requested = Number(context.req.query("days"));
  const days = RANGES.includes(requested) ? requested : 7;
  const timeZone = resolveTimeZone(context.req.query("tz"));
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const now = Math.floor(Date.now() / 1000);

  // The last `days` calendar days in the viewer's timezone, oldest first.
  const dayList: string[] = [];
  for (let back = days - 1; back >= 0; back -= 1) dayList.push(dayKey(now - back * DAY, formatter));
  const firstDay = dayList[0]!;

  // Pad the fetch by a day each side, then keep exactly the rows whose local day is in range.
  const since = now - (days + 1) * DAY;
  const [postedResult, failedResult, scheduledResult, totalsResult, topResult] = await Promise.all([
    database
      .prepare(
        `SELECT posts.id, posts.content, posts.posted_at, social_accounts.platform, social_accounts.display_name AS account_display_name,
                posts.metric_views, posts.metric_likes, posts.metric_comments, posts.metric_shares
           FROM posts JOIN social_accounts ON social_accounts.id = posts.social_account_id
          WHERE posts.user_id = ? AND posts.status = 'posted' AND posts.posted_at >= ?`,
      )
      .bind(userId, since)
      .all<PostedRow>(),
    database.prepare("SELECT updated_at FROM posts WHERE user_id = ? AND status = 'failed' AND updated_at >= ?").bind(userId, since).all<{ updated_at: number }>(),
    database.prepare("SELECT count(*) AS n FROM posts WHERE user_id = ? AND status = 'scheduled'").bind(userId).first<{ n: number }>(),
    database
      .prepare(
        `SELECT coalesce(sum(metric_views), 0) AS views, coalesce(sum(metric_likes), 0) AS likes,
                coalesce(sum(metric_comments), 0) AS comments, coalesce(sum(metric_shares), 0) AS shares,
                count(metrics_updated_at) AS posts_with_metrics, count(*) AS posts_posted, max(metrics_updated_at) AS metrics_updated_at
           FROM posts WHERE user_id = ? AND status = 'posted'`,
      )
      .bind(userId)
      .first<{ views: number; likes: number; comments: number; shares: number; posts_with_metrics: number; posts_posted: number; metrics_updated_at: number | null }>(),
    database
      .prepare(
        `SELECT posts.id, posts.content, posts.metric_views, posts.metric_likes, posts.metric_comments, posts.posted_at, social_accounts.platform
           FROM posts JOIN social_accounts ON social_accounts.id = posts.social_account_id
          WHERE posts.user_id = ? AND posts.status = 'posted' AND posts.posted_at >= ?
            AND (posts.metric_views IS NOT NULL OR posts.metric_likes IS NOT NULL)
          ORDER BY coalesce(posts.metric_views, posts.metric_likes, 0) DESC LIMIT 1`,
      )
      .bind(userId, now - 7 * DAY)
      .first<Record<string, unknown> & { posted_at: number }>(),
  ]);

  const inRange = postedResult.results.filter((row) => dayKey(row.posted_at, formatter) >= firstDay);
  const byDay = new Map<string, PostedRow[]>();
  for (const row of inRange) {
    const key = dayKey(row.posted_at, formatter);
    byDay.set(key, [...(byDay.get(key) ?? []), row]);
  }
  const plain = (value: Metric) => value ?? 0;

  const viewed = inRange.filter((row) => (row.metric_views ?? 0) > 0);
  const viewedTotal = viewed.reduce((total, row) => total + row.metric_views!, 0);
  const engaged = viewed.reduce((total, row) => total + plain(row.metric_likes) + plain(row.metric_comments) + plain(row.metric_shares), 0);

  const platforms = new Map<string, PostedRow[]>();
  for (const row of inRange) platforms.set(row.platform, [...(platforms.get(row.platform) ?? []), row]);

  const engagement = (row: PostedRow) => plain(row.metric_likes) + plain(row.metric_comments) + plain(row.metric_shares);
  const top = [...inRange]
    .sort((a, b) => (b.metric_views ?? -1) - (a.metric_views ?? -1) || engagement(b) - engagement(a) || b.posted_at - a.posted_at)
    .slice(0, POSTS_LISTED);

  const totals = totalsResult!;
  return context.json({
    range: { days, timeZone },
    days: dayList.map((date) => {
      const rows = byDay.get(date) ?? [];
      return {
        date,
        published: rows.length,
        views: sum(rows.map((row) => row.metric_views)) ?? 0,
        likes: sum(rows.map((row) => row.metric_likes)) ?? 0,
        comments: sum(rows.map((row) => row.metric_comments)) ?? 0,
        shares: sum(rows.map((row) => row.metric_shares)) ?? 0,
      };
    }),
    period: {
      published: inRange.length,
      failed: failedResult.results.filter((row) => dayKey(row.updated_at, formatter) >= firstDay).length,
      scheduled: scheduledResult?.n ?? 0,
      views: sum(inRange.map((row) => row.metric_views)),
      likes: sum(inRange.map((row) => row.metric_likes)),
      comments: sum(inRange.map((row) => row.metric_comments)),
      shares: sum(inRange.map((row) => row.metric_shares)),
      // Only over posts that report views, so platforms without view counts do not inflate it.
      engagementRate: viewedTotal > 0 ? engaged / viewedTotal : null,
    },
    platforms: [...platforms.entries()]
      .map(([platform, rows]) => ({
        platform,
        posts: rows.length,
        views: sum(rows.map((row) => row.metric_views)),
        likes: sum(rows.map((row) => row.metric_likes)),
        comments: sum(rows.map((row) => row.metric_comments)),
        shares: sum(rows.map((row) => row.metric_shares)),
      }))
      .sort((a, b) => b.posts - a.posts || a.platform.localeCompare(b.platform)),
    posts: top.map((row) => ({ ...row, posted_at: iso(row.posted_at) })),
    metricsUpdatedAt: iso(totals.metrics_updated_at),
    totals: { views: totals.views, likes: totals.likes, comments: totals.comments, shares: totals.shares },
    postsWithMetrics: totals.posts_with_metrics,
    postsPosted: totals.posts_posted,
    topPost: topResult ? { ...topResult, posted_at: iso(topResult.posted_at) } : null,
  });
});
