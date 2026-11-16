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

## Current boundary

The only deployed behavior at this stage is a D1-backed health endpoint and a
per-minute scheduled invocation record. It proves the runtime, binding, logging,
and cron path without activating any social publishing, OAuth callback, media,
or user route. Those features remain served only by Docker until their own
migration and verification steps are complete.
