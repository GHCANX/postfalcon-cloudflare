import { mailConfigured } from "./mailer";

/**
 * The dashboard's "Get started" checklist, worked out from what the owner has
 * actually done so it ticks itself off however they did it.
 */
export async function onboardingStatus(database: D1Database, userId: number) {
  const row = await database
    .prepare(
      `SELECT onboarding_dismissed_at IS NOT NULL AS dismissed,
              EXISTS (SELECT 1 FROM social_accounts WHERE user_id = users.id) AS account,
              EXISTS (SELECT 1 FROM posts WHERE user_id = users.id AND status <> 'draft') AS post,
              EXISTS (SELECT 1 FROM api_tokens WHERE user_id = users.id) AS agent
         FROM users WHERE id = ?`,
    )
    .bind(userId)
    .first<{ dismissed: number; account: number; post: number; agent: number }>();
  const account = row?.account === 1;
  const post = row?.post === 1;
  const complete = account && post;
  const dismissed = row?.dismissed === 1;
  return {
    account,
    post,
    agent: row?.agent === 1,
    complete,
    dismissed,
    show: !dismissed && !complete,
    quickPlatforms: ["Mastodon", "Bluesky", "Telegram"],
  };
}

/** Admins only: what a fresh instance still needs. Email is the one step this deployment has. */
export async function adminSetupStatus(env: Env, userId: number, isAdmin: boolean) {
  if (!isAdmin) return null;
  const row = await env.DB.prepare("SELECT admin_setup_dismissed_at IS NOT NULL AS dismissed FROM users WHERE id = ?").bind(userId).first<{ dismissed: number }>();
  const steps = [{ id: "email", done: mailConfigured(env) }];
  const doneCount = steps.filter((step) => step.done).length;
  const dismissed = row?.dismissed === 1;
  return { steps, doneCount, complete: doneCount === steps.length, dismissed, show: !dismissed && doneCount < steps.length };
}
