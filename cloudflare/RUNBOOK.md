# Operations runbook: backup, restore, cutover, rollback, quota review

For the one-owner Cloudflare deployment. Commands that change the live account
are marked **[live]**. Do every rehearsal on `postfalcon-staging` first. Prefix
`cf` with `PATH=$HOME/.nvm/versions/node/v24.17.0/bin:$PATH`. Commands marked
**(rehearsed)** were run against a scratch D1 on 2026-11-18; the rest have not
been exercised, so check `cf <command> --help` first.

## Recovery targets

| Event | Target |
| --- | --- |
| Due posts rediscovered after a Cloudflare outage or bad deploy | within 5 minutes of service returning (the per-minute cron sweeps overdue work) |
| App restored after an operator-initiated restore or rollback | within 1 hour |
| Data loss window | D1 Time Travel: any minute in the last 7 days. Older: the last weekly export |

Ambiguous publishes are never retried automatically; they wait in `review_required`.

## 1. Backups

**Fast restore: D1 Time Travel** (free, 7 days, automatic).

```sh
cf d1 time-travel get-bookmark <database-id>                 # note it before risky work
cf d1 time-travel restore <database-id> --bookmark <id> --force   # [live] (rehearsed; or --timestamp <ISO time>; --force is required non-interactively)
```

Restoring rewinds the whole database, including posts that were published
after that time. After any restore, before the scheduler runs again, turn
posts that may already have gone out into reviews:

```sql
UPDATE posts SET status = 'review_required',
       review_reason = 'Restored from backup; confirm on the platform before retrying.'
 WHERE status IN ('scheduled','posting') AND scheduled_for <= unixepoch();
```

**Before every schema migration and before cutover:** take a bookmark (above)
and a SQL export. There is no `cf d1 export` command; use the REST export
endpoint (`cf schema` shows its request shape) with a token limited to D1 edit
on this one database, run from your machine, never stored in the repo.

**Weekly export to R2 (`backups/` prefix, four kept)** is not built yet: it
needs that API token as a Worker secret and a dedicated Workflow. Until it
exists, Time Travel's 7 days is the only automatic backup, so take a manual
export weekly.

## 2. Restore rehearsal (gate for cutover)

1. Create a scratch D1 database **[live]**, apply `migrations/` to it, import the export.
2. Run `npm run typecheck`; point a scratch deploy (or `cf dev` with `--local`) at it and sign in.
3. Check: post counts match; scheduled posts appear; a media URL resolves; `/healthz` ok.
4. Record elapsed time against the 1-hour target in the plan. Delete the scratch database.

## 3. Migrating from the Docker/PostgreSQL app

`scripts/import-postgres.mjs` reads PostgreSQL (read-only) and writes
`import.sql`, `media.json` and `report.json`. It keeps ids, converts
timestamps to unix seconds, booleans to 0/1 and JSON to text, and does **not**
carry sessions, one-time tokens, analytics, billing or invites (everyone signs
in again).

Two rows change on purpose, and `report.json` lists each: a post still
`posting` becomes `review_required` (it may or may not have gone out), and
a `gif` media type becomes `image`. Imported `scheduled` posts have no
workflow yet; the per-minute cron creates it.

Rehearse the whole sequence against staging first (use a copy of the data):

1. Stop the Docker scheduler so nothing publishes from two places: stop the
   app process (`scheduler.js` runs inside it). Keep PostgreSQL running, read-only use.
2. `npm i --no-save pg`, then
   `DATABASE_URL=… node scripts/import-postgres.mjs --media-dir <uploads dir> --out-dir ./migration-out`.
   Fix anything in `report.json` (`missingMedia` means a post points at a file that is gone).
3. Take a bookmark of the target D1, apply `migrations/` if it is new, then
   apply it **[live]** (rehearsed): `cf d1 migrations apply <id>`, then
   `cf d1 query <id> --batch @migration-out/import.batch.json` (`--sql` fails on
   a real file: the argument is too long). 500 posts / 400 media rows took 2 s.
4. Copy each file in `media.json` to R2 under its `key` **[live]** with
   `cf r2 objects put`. The Worker's R2 budget counts only its own calls, so
   count these uploads yourself against the 100,000 Class A cap (one per file).
5. Verify: row counts equal `report.json` counts; every `media_files.r2_key`
   exists in the bucket; sign in (password hashes carry over); reconnect any
   account the Admin overview flags; open a few `/uploads/<name>` URLs.
6. Reconnect OAuth platforms from the new origin if tokens do not work there
   (Meta/TikTok tokens usually carry over; a changed redirect host does not break
   already-issued tokens, but the platform consoles must list the new callback URLs).

## 4. Cutover (production)

Only after sections 2 and 3 pass on staging, and the checklist in
`CLOUDFLARE_PLAN.md` is complete.

1. Take a final PostgreSQL dump and keep it. Stop the Docker app (scheduler off).
2. Run section 3 steps 2–5 against the **production** D1 and R2.
3. Set production secrets (README "Configuration reference") and deploy **[live]**.
4. Move the custom domain to the production Worker: remove it from
   `postfalcon-staging` first, since one hostname cannot be claimed twice.
5. Update every platform console's callback URLs if the origin changed.
6. Watch Admin → Overview for a full day: scheduler heartbeat, overdue posts, reviews.

## 5. Rollback

Once D1 takes production writes, **do not** restart Docker on the stale
PostgreSQL data: it would republish posts the Worker already sent.

- Bad deploy: redeploy the previous version; D1 is untouched.
- Bad data: Time Travel restore (section 1), then the `review_required` UPDATE.
- Cloudflare unavailable for a long time: scheduled posts are kept in D1 and
  picked up when it returns. Going back to Docker requires a reverse import
  (D1 → PostgreSQL) that has not been written; decide that need before cutover.
- Never run both schedulers. Pause the Worker first (disable its cron
  trigger / switch every platform off in Admin → Platforms), then start Docker.

## 6. Free-tier review (do before cutover, then monthly)

| Resource | Free allowance (verify current figures on Cloudflare's pricing pages) | One-owner estimate | Where to look |
| --- | --- | --- | --- |
| Worker requests | 100,000/day | page loads + 1,440 cron runs/day | dashboard → Workers → Metrics |
| D1 | 5M rows read/day, 100k written/day, 5 GB | cron sweep + UI; far below | `cf d1 insights databases` / `queries` |
| R2 | 10 GB, 1M Class A, 10M Class B per month | app caps are 8 GB / 100k / 1M | Admin → Overview (R2 use vs caps) |
| Workflows | free-plan instance and step limits | one instance per scheduled post | dashboard → Workflows |
| Cron triggers | 5 per account | uses 1 | `cloudflare.config.ts` |

Checks: R2 use under 80% of every cap (Overview flags it), no overdue posts,
no recurring errors in Admin → Activity → Server errors. A hard limit being hit
pauses work, never bills: Workers Free is not upgraded automatically. Use a
dedicated Cloudflare account so other workloads cannot spend the shared limits.
