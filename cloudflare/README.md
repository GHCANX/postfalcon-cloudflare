# Postfalcon Cloudflare runtime

This directory is an isolated Workers/D1/R2 deployment path. It does not replace
the Docker runtime yet, and it intentionally contains no production account IDs,
domains, API keys, or OAuth credentials.

## Prerequisites

- Node.js 22.23 or newer. The pinned Cloudflare `cf` CLI loads
  `cloudflare.config.ts` on a supported Node 22 runtime.
- A Cloudflare account authenticated through `cf login`.
- Separate staging and production D1 databases named `postfalcon-staging` and
  `postfalcon-production`, plus private R2 buckets named
  `postfalcon-staging-media` and `postfalcon-production-media`.

The committed configuration binds the reviewed staging D1 database only. A
production database ID is deliberately not committed or created until the
staging deployment and data-migration rehearsal have passed.

## First local check

```sh
cd cloudflare
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Open `/` for the isolated foundation page and `/healthz` to verify that the
Worker can query D1. Before starting the Worker, apply the foundation migration
to the intended database:

```sh
npm run d1:migrate:staging
```

Generate binding types before type-checking:

```sh
npm run typecheck
```

`cf` obtains the account from its authenticated profile; do not add account IDs
to `cloudflare.config.ts`. Store actual secrets with the Cloudflare secret
command for the correct mode/deployment, never in `.dev.vars.example` or source.
Mailgun and session secrets are intentionally not declared until the routes that
consume them are implemented, so a foundation deployment cannot silently carry
placeholder credentials.

The repository's original Docker application may use a different Node version.
Only this `cloudflare/` subproject requires Node 22.23+. It has been validated
with Node 22.23.0; use a version manager or a CI image that supplies that
runtime rather than changing the Docker image as part of this migration.

## Secrets

`SESSION_SECRET` (signs session/CSRF values and keys rate limits) and
`SETUP_TOKEN` (one-time proof of ownership for creating the owner account) are
declared in `cloudflare.config.ts`. Set each with
`cf workers secrets update <NAME> --worker postfalcon-staging --text <value>`
(32+ random characters; `openssl rand -hex 32`). Without them every `/api`
route answers 503. Locally, put them in `.dev.vars`.

First sign-in on a fresh instance: `POST /api/setup` with
`{setup_token, email, password}` (after fetching `GET /api/csrf-token`). It only
works while the users table is empty; after that `/api/users` stays closed.

## Email (Mailgun)

Email is optional and off until configured. Set four values as ordinary Worker
secrets (they are deliberately not declared in `cloudflare.config.ts`, so the
instance deploys and runs without them, and a secret set this way survives later
deploys):

```sh
cf workers secrets update MAILGUN_API_KEY --worker postfalcon-staging --type secret_text --text <key>
cf workers secrets update MAILGUN_DOMAIN  --worker postfalcon-staging --type secret_text --text mg.example.com
cf workers secrets update MAILGUN_FROM    --worker postfalcon-staging --type secret_text --text "Postfalcon <postfalcon@mg.example.com>"
cf workers secrets update MAILGUN_REGION  --worker postfalcon-staging --type secret_text --text eu   # only for Mailgun's EU region
```

Then `POST /api/admin/test-email` sends one to the signed-in admin. Emails sent:
password reset, email verification, "post needs review" and "reconnect this
account". Every send is recorded (recipient, category, status; never the body)
in `email_deliveries`.

## API surface (staging)

All under `/api`, session cookie or `Authorization: Bearer pf_…`; state-changing
cookie requests need the `x-csrf-token` from `GET /api/csrf-token`.

| Area | Routes |
| --- | --- |
| Identity | `POST /setup`, `POST /auth/login`, `/auth/logout`, `GET /auth/me`, `POST /auth/change-password`, `/auth/forgot-password`, `/auth/reset-password`, `GET /auth/verify-email`, `POST /auth/resend-verification`, `GET/POST/DELETE /auth/api-token` |
| Admin | `GET /admin/overview`, `GET /admin/review`, `POST /admin/posts/:id/resolve`, `POST /admin/test-email` |
| Webhooks | `GET/POST /v1/webhooks`, `DELETE /v1/webhooks/:id`, `GET /v1/webhooks/:id/deliveries` |
| Analytics / MCP | `GET /v1/analytics/summary`, `POST /mcp` (Bearer only) |
| Accounts | `GET /social-accounts`, `DELETE /social-accounts/:id`, `POST /bluesky/connect`, `POST /telegram/connect`, `GET /mastodon/connect?instance=` (+ callback) |
| Media | `POST /v1/media` (raw image body, `Content-Type: image/*`, max 25 MiB), public `GET /uploads/<uuid>.<ext>` |
| Posts | `GET/POST /v1/posts`, `GET/PATCH/DELETE /v1/posts/:id` (JSON; attach uploads with `media_ids`) |

Publishing: Mastodon, Telegram and Bluesky have Worker adapters. A failure
before the platform accepted the post is retried (up to 3 attempts); a refused
post is `failed`; a timeout or 5xx on the final create goes to
`review_required` and is never retried automatically.

## Current boundary

The only deployed behavior at this stage is a D1-backed health endpoint and a
per-minute scheduled invocation record. It proves the runtime, binding, logging,
and cron path without activating any social publishing, OAuth callback, media,
or user route. Those features remain served only by Docker until their own
migration and verification steps are complete.
