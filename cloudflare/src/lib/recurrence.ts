const DAY = 24 * 60 * 60;
const HARD_CAP_SECONDS = 366 * DAY;

/** The occurrence after `from` (Unix seconds), in UTC. Monthly uses calendar months. */
export function addInterval(from: number, interval: string): number {
  if (interval === "daily") return from + DAY;
  if (interval === "weekly") return from + 7 * DAY;
  // Same day next month, clamped to the month's last day (Jan 31 -> Feb 28),
  // rather than overflowing into the month after.
  const date = new Date(from * 1000);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return Math.floor(date.getTime() / 1000);
}

type Source = {
  user_id: number;
  social_account_id: number;
  scheduled_for: number | null;
  repeat_interval: string | null;
  repeat_until: number | null;
  repeat_parent_id: number | null;
};

/**
 * After a recurring post is published, queues its next occurrence as a new
 * scheduled post that points at the same stored media. Safe to call more than
 * once for the same post: a next occurrence that already exists is not
 * duplicated. Occurrences already in the past (the instance was down or late)
 * are skipped rather than published back to back; a one-year cap and
 * `repeat_until` stop the series. Returns the new post id, or null.
 */
export async function scheduleNextOccurrence(
  database: D1Database,
  postId: number,
  now = Math.floor(Date.now() / 1000),
): Promise<number | null> {
  const post = await database
    .prepare(
      `SELECT user_id, social_account_id, scheduled_for, repeat_interval, repeat_until, repeat_parent_id
         FROM posts WHERE id = ?`,
    )
    .bind(postId)
    .first<Source>();
  if (!post?.repeat_interval || post.scheduled_for === null) return null;

  const hardCap = now + HARD_CAP_SECONDS;
  const until = post.repeat_until ?? hardCap;
  let next = addInterval(post.scheduled_for, post.repeat_interval);
  while (next <= now) next = addInterval(next, post.repeat_interval);
  if (next > until || next > hardCap) return null;

  const rootId = post.repeat_parent_id ?? postId;
  const created = await database
    .prepare(
      `INSERT INTO posts (user_id, social_account_id, content, status, scheduled_for, repeat_interval, repeat_until,
                          repeat_parent_id, crosspost_group_id, platform_options_json)
       SELECT user_id, social_account_id, content, 'scheduled', ?, repeat_interval, repeat_until, ?, crosspost_group_id,
              platform_options_json
         FROM posts
        WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM posts WHERE repeat_parent_id = ? AND social_account_id = ? AND scheduled_for = ?)
       RETURNING id`,
    )
    .bind(next, rootId, postId, rootId, post.social_account_id, next)
    .first<{ id: number }>();
  if (!created) return null;

  await database
    .prepare(
      `INSERT INTO post_media (post_id, url, media_type, content_type, byte_size, alt_text, position, media_file_id)
       SELECT ?, url, media_type, content_type, byte_size, alt_text, position, media_file_id
         FROM post_media WHERE post_id = ?`,
    )
    .bind(created.id, postId)
    .run();
  return created.id;
}
