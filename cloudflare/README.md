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

## Configuration reference

Three kinds of setting, all read as `env.<NAME>` in the Worker.

**Declared secrets** (in `cloudflare.config.ts`; the deploy fails or the API answers 503 without them):

| Name | Purpose |
| --- | --- |
| `SESSION_SECRET` | Signs sessions and CSRF values, keys rate limits. 32+ random characters. |
| `SETUP_TOKEN` | One-time proof of ownership for creating the owner account. |

**Variables** (plain text in `cloudflare.config.ts`, changed by editing it and redeploying):

| Name | Purpose |
| --- | --- |
| `APP_PROFILE` | Deployment profile, `self-hosted-single-user`. |
| `PUBLIC_BASE_URL` | The Worker's public origin, no trailing path (staging: `https://socialmedia.endlesscarousel.pink`). Platforms that fetch media (Instagram, Threads, Pinterest) read `<origin>/uploads/<name>`, and every OAuth redirect URI below must be on this origin: start a connect flow from it, not from `workers.dev`. |
| `R2_BUDGET` | R2 usage caps (see Media uploads). |

**Optional secrets** (not declared in the config, so the instance runs without them and a feature stays off until its secrets exist). Set each with:

```bash
cf workers secrets update <NAME> --worker postfalcon-staging --type secret_text --text '<value>'
```

A secret set this way survives later deploys. Use `--worker postfalcon-production` for production. A platform is offered on the Accounts page only when it is switched on in Admin → Platforms **and** every required secret is set.

| Feature | Required secrets | Optional | Also needs |
| --- | --- | --- | --- |
| Email | `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_FROM` | `MAILGUN_REGION` (`eu` for the EU region) | |
| Facebook Pages + Instagram | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | `FACEBOOK_CONFIG_ID` (Business-type Meta app) | `PUBLIC_BASE_URL` (Instagram) |
| Threads | `THREADS_CLIENT_ID`, `THREADS_CLIENT_SECRET` | | `PUBLIC_BASE_URL` |
| YouTube | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | | |
| Pinterest | `PINTEREST_APP_ID`, `PINTEREST_APP_SECRET` | | `PUBLIC_BASE_URL` |
| LinkedIn | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | | |
| TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | | |

Mastodon, Telegram and Bluesky need no operator secrets: users bring their own instance, bot token or app password. Admin → Platforms shows, per platform, which secrets are set and the exact redirect URIs to register. Locally, put any of these in `.dev.vars`.

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

## Media uploads

Images (JPEG/PNG/WebP/GIF) and video (MP4/MOV/WebM) share one stored-file path.
Cloudflare caps a single request body at 100 MB, so files are limited by type:

- **Images and any single-request upload: 25 MiB.** `POST /api/v1/media` takes
  the raw file as the body.
- **Video: up to 300 MiB (300 MiB = `maxObjectBytes`), uploaded in parts.** The
  browser does this automatically when a post's attachments exceed ~24 MiB;
  the API is `POST /api/v1/media/uploads` `{content_type, size}` →
  `PUT /api/v1/media/uploads/:id/parts/:n` (raw body, exact Content-Length,
  32 MiB parts) → `POST .../complete`, or `DELETE .../uploads/:id` to abort.
  The declared size is reserved against the R2 budget up front and returned on
  abort; uploads idle for 24 h are swept.

The budget caps still apply on top: 7 GiB of media and 8 GiB total per instance
(about 23 maximum-size videos), plus monthly Class A/B operation ceilings in
`R2_BUDGET` (`cloudflare.config.ts`). Each chunked upload costs Class A
operations for the create, every part, and the complete (parts + 2); each
public read by a platform costs one Class B.

## Platform apps (Meta, Threads, YouTube, Pinterest, LinkedIn, TikTok)

Each is off until their developer-app credentials exist (the Accounts page only
offers a platform whose secrets are set). Same mechanism as Mailgun: undeclared
secrets set with `cf workers secrets update <NAME> --worker <worker> --type secret_text --text <value>`.

| Platform | Secrets | Redirect URI to register |
| --- | --- | --- |
| Facebook Pages and Instagram (one Facebook Login) | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, optionally `FACEBOOK_CONFIG_ID` (Business-type Meta app), and `PUBLIC_BASE_URL` | `<origin>/api/facebook/callback` |
| Threads (its own Meta app) | `THREADS_CLIENT_ID`, `THREADS_CLIENT_SECRET`, `PUBLIC_BASE_URL` | `<origin>/api/threads/callback` |
| YouTube (Google OAuth client) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `<origin>/api/youtube/callback` |
| Pinterest | `PINTEREST_APP_ID`, `PINTEREST_APP_SECRET`, `PUBLIC_BASE_URL` | `<origin>/api/pinterest/callback` |
| LinkedIn | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | `<origin>/api/linkedin/callback` |
| TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | `<origin>/api/tiktok/callback` |

- **Facebook** posts to the Pages you manage: text, up to 10 photos, or one video
  (up to 64 MiB, read whole into memory). The same login also connects Instagram;
  either can be switched off in Admin → Platforms. The Meta app needs
  `pages_manage_posts` in App Review.
- **Threads** posts text, images, videos and carousels (media is fetched from
  `<PUBLIC_BASE_URL>/uploads/<name>`). The 60-day token refreshes itself when under
  a week is left.
- **YouTube** is video only, uploaded in 8 MiB resumable chunks read from R2, so
  large files never sit in memory. Uploads are private by default and forced
  private until Google's API audit passes. Metrics read views, likes and comments.
- **Pinterest** posts an image Pin (fetched from `<PUBLIC_BASE_URL>/uploads/`) to the
  board chosen on the Accounts page; a refused board falls through to another or a
  new "Postfalcon" board. Trial-tier apps can only pin in Pinterest's sandbox, which
  this deployment does not target — apply for Standard access first.
- **LinkedIn** posts text to the personal profile. The ~60-day token has no refresh;
  a failed post flags the account for reconnecting.
- **Instagram** needs an Instagram business account linked to a Facebook Page.
  Instagram downloads each image from `<PUBLIC_BASE_URL>/uploads/<name>`, so set
  `PUBLIC_BASE_URL` to the Worker's public origin (no trailing path). Only JPEG
  images are accepted: the Docker app converts other formats with `sharp`, which
  Workers cannot run, so a PNG/WebP/GIF post fails with a clear message. Image
  ratio limits (4:5 to 1.91:1) are enforced by Instagram, not adjusted here.
- **TikTok** posts video only (MP4, MOV, or WebM). Files up to 64 MiB go in one
  chunk; larger files are read from R2 in 16 MiB ranges and the last chunk
  absorbs the remainder. Connecting, token refresh, the composer's creator-info
  panel and the publish flow are in place. Until the app passes TikTok's Direct
  Post audit, posts can only be private.

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
| Media | `POST /v1/media` (raw file body, max 25 MiB), chunked `POST /v1/media/uploads` + `PUT .../parts/:n` + `POST .../complete` for video up to 300 MiB, public `GET /uploads/<uuid>.<ext>` (byte ranges) |
| Posts | `GET/POST /v1/posts`, `GET/PATCH/DELETE /v1/posts/:id` (JSON; attach uploads with `media_ids`) |

Publishing: Mastodon, Telegram and Bluesky have Worker adapters. A failure
before the platform accepted the post is retried (up to 3 attempts); a refused
post is `failed`; a timeout or 5xx on the final create goes to
`review_required` and is never retried automatically.

## Current boundary

Staging runs the ported UI and API: auth, the composer with chunked media
uploads, Mastodon/Telegram/Bluesky publishing, Facebook, Instagram, Threads,
YouTube, Pinterest, LinkedIn and TikTok connect flows and adapters (none verified against
the real platforms — no developer apps yet),
Mailgun email when its secrets are set, webhooks, and the per-minute publish
cron. See `CLOUDFLARE_PLAN.md` for what is verified and what is not.
