# Postfalcon on Cloudflare

A port of [Postfalcon](https://postfalcon.co), the open-source social media scheduler, to run as
**one self-hosted, single-owner instance on Cloudflare's free services**. Write a post once, schedule
it, and it is published on time to Mastodon, Bluesky and Telegram today, with Instagram and TikTok
connect flows built but not yet verified against the real platforms.

The Cloudflare runtime lives in [`cloudflare/`](cloudflare/) (TypeScript + Hono on Workers). The
original Node/Express app (everything outside `cloudflare/`) is kept as source: the port reuses its
UI (`public/`, `views/`) and follows its data model. Its Docker, pm2 and Caddy packaging was removed
from this repo.

**Status:** runs on a staging Worker; no production resources exist yet. See
[`CLOUDFLARE_PLAN.md`](CLOUDFLARE_PLAN.md) for the roadmap, progress log and what is verified, and
[`cloudflare/README.md`](cloudflare/README.md) for the operator guide (setup, secrets, email, media,
API).

## What changed to run on Cloudflare

| Original app | Cloudflare port |
| --- | --- |
| Express + EJS | Workers + Hono; the original UI is built from `public/` and `views/` plus `cloudflare/overrides/` |
| Postgres, sessions in the DB | D1 (SQLite) for everything, including sessions; migrations in `cloudflare/migrations/` |
| Local disk or S3 uploads | R2, with hard budget caps in code (`r2-budget.ts`) so it can never bill |
| `node-cron` per-minute publisher | Cloudflare Workflows for delivery, plus a per-minute Cron Trigger as reconciliation |
| SMTP (nodemailer) | Mailgun HTTP API (Workers have no SMTP); optional, off until configured |
| Image conversion with `sharp` | Not available on Workers: Instagram takes JPEG only |
| Stripe plans and billing | Deferred; single owner, no plans |
| pm2 / Docker / Caddy | `cf` CLI with a typed `cloudflare.config.ts` (no Wrangler) |

## Guarantees

- **Zero cost.** No Containers, no Workers Paid. R2 is capped at 25 MiB per file (images), 300 MiB
  per chunked video, 7 GiB of media, 8 GiB total, and 100k Class A / 1M Class B operations a month.
  Over budget fails closed.
- **No lost posts.** Scheduled delivery runs as a Workflow, and a cron reconciles anything missed.
- **No double posts.** A publish that fails before the platform accepted it is retried (up to 3
  attempts). One that times out ambiguously is never retried automatically: it goes to
  `review_required` with an email alert for manual review.

## What works today

- Owner setup, login, password reset, email verification, API tokens, CSRF, rate limits
- Composer and calendar, drafts, recurring posts, cross-posting
- Image uploads and chunked video uploads up to 300 MiB
- Publishing: Mastodon, Bluesky, Telegram. Connect flows for Instagram and TikTok (unverified)
- Webhooks, analytics, an MCP endpoint (`POST /mcp`), and admin pages (overview, platforms,
  settings, activity, review queue)

Not ported yet: Facebook, Threads, YouTube, Pinterest, LinkedIn, X, and Stripe billing.

## Quick start

Needs Node 22.23+ and a Cloudflare account signed in with `cf login`.

```bash
cd cloudflare
npm install
cp .dev.vars.example .dev.vars
npm run d1:migrate:staging
npm run dev
```

Deploying and applying migrations change your live Cloudflare account; follow
[`cloudflare/README.md`](cloudflare/README.md) before running them.

## About the original app

The Express app can still be run for development (`npm install`, `cp .env.example .env`,
`npm run migrate`, `npm run dev`; tests with `npm test` against a Postgres test database).
[`CLAUDE.md`](CLAUDE.md) describes its architecture and conventions. It is not packaged for
deployment from this repo.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[GNU Affero General Public License v3.0](LICENSE) or later. If you offer a modified version to
other people over a network, you must make your changes available to them under the same license.
