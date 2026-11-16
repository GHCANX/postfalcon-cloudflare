# Cloudflare Free Deployment Plan

## Goal

Restructure Postfalcon for one self-hosted instance on Cloudflare's free services, with one primary user and a few connected social accounts. Keep the existing Docker deployment available while the Cloudflare path is developed and validated. The first priority is a complete, reviewable implementation plan; implementation starts only after the plan's architecture, feature roadmap, failure handling, data migration, and cost controls are sufficiently specified.

This is a planning document only. No application code or deployment behavior has been changed yet.

## Target architecture

| Current responsibility | Proposed Cloudflare service | Planned change |
| --- | --- | --- |
| Express app and rendered pages | Cloudflare Workers + Hono | Replace the long-running Express listener with a native Worker request handler. Use Hono for routing and Workers Static Assets for immutable static files; preserve EJS only if a bundled-template proof of concept works cleanly, otherwise move views to a Worker-compatible renderer. |
| PostgreSQL and `pg` | Cloudflare D1 | Port schema, migrations, queries, and session persistence from PostgreSQL to SQLite/D1. |
| Persistent media and public `/uploads` URLs | Cloudflare R2 | Replace disk staging and AWS S3 SDK operations with R2 bindings and request-compatible media handlers. Keep media private in the bucket and served through the app. |
| `node-cron` in the app process | Workflows + D1 + Cron Triggers | Use one durable Workflow per scheduled delivery to sleep until due and handle retryable steps. Keep D1 authoritative for post state. Use a frequent Cron Trigger as a reconciliation and maintenance sweep so due work can be rediscovered if a workflow was not created or did not resume. |
| Caddy and TLS | Cloudflare Workers custom domain | Remove Caddy from the Cloudflare deployment path; retain it in Docker deployment. |
| `pg_dump` and local backup directory | D1 export/restore workflow plus R2 | Replace `child_process`, PostgreSQL dump format, and local backup management with D1-compatible export, restore, and retention operations. |
| Static assets and EJS templates | Workers Static Assets / bundled views | Serve static assets from Workers Static Assets. Keep dynamic templates in the Worker bundle and render them without filesystem reads, or replace EJS if the prototype shows incompatibilities. |

Because this checkout has no Cloudflare project configuration, use Cloudflare's current `cf` CLI and native project configuration for the new deployment path. Keep the Docker scripts independent. Do not add a Wrangler project configuration as part of the initial scaffold; revisit the CLI choice only if the project explicitly adopts Wrangler later.

The custom domain and DNS may have separate registration costs. “Zero cost” means no required monthly Cloudflare application hosting charge and application-level controls designed to stay within free allowances. It does not guarantee free domains, email delivery, social-platform APIs, or unlimited usage. The implementation must fail closed or pause nonessential work before application-controlled usage can exceed configured budgets; Cloudflare free quotas and external provider availability still cannot be made unlimited or guaranteed by application code.

## Planned code changes

### 1. Add a Cloudflare runtime entry point

- Add a Worker entry module, Hono router, Workers Static Assets, and bindings for D1, R2, and the post-delivery Workflow.
- Adapt request handling so the application accepts the Worker `Request` and returns a `Response`; remove reliance on `app.listen()` in this runtime.
- Audit Express middleware and dependencies for Workers compatibility. Replace unsupported server, filesystem, process, or native-module assumptions as needed. Keep static assets separate from dynamic routes and bundle any dynamic templates.
- Keep `index.js` as the Node/Docker entry point unless shared app code can cleanly support both runtimes.

### 2. Introduce a storage/data access boundary

- Replace direct `pg.Pool` access with a data access module that can be implemented for D1.
- Port every migration and SQL query to D1 SQLite syntax and binding semantics. Review PostgreSQL arrays/`ANY`, JSON types/operators, timestamps, `RETURNING`, conflict handling, and transaction use.
- Rework persistent sessions: `connect-pg-simple` cannot remain the session store after the database move. Select and implement a D1-backed session design with expiry cleanup and secure cookie settings.
- Preserve migration ordering and make D1 schema upgrades explicit and repeatable.

### 3. Move uploads and media processing to R2

- Replace Multer disk staging with a streamed Worker-to-R2 upload flow. Avoid browser presigned uploads in the first release so Postfalcon can enforce size, storage, and operation budgets before each write.
- Add hard application-side R2 budgets for stored bytes, per-file size, upload count/operations, and optional read-operation ceilings. Reserve headroom below Cloudflare's included allowance, reject new uploads before the configured cap, and provide an admin usage display. Do not rely only on billing alerts as the cost control.
- Implement R2 put/get/head/delete/copy/list operations for existing storage helpers and the `/uploads/:name` route, including byte-range responses needed for video consumers.
- Set a first-release per-file maximum of 25 MB for image uploads. Reject unsupported sizes clearly; reconsider direct/resumable uploads only in a later phase with separate budget enforcement.
- Replace or remove `sharp` image processing after checking whether a Worker-compatible image path meets platform requirements.
- Keep backup objects in a separate R2 prefix and never expose that prefix through public media routes.

### 4. Move scheduled work to Workflows and Cron Triggers

- Refactor `scheduler.js` into independently callable units: due-post publishing, media cleanup, activity cleanup, metrics refresh, stored platform refresh, alerts, error pruning, backups, and billing reconciliation.
- Implement a durable Cloudflare Workflow per post delivery. Persist the scheduled record and workflow ID in D1, have the Workflow sleep until the due time, and let D1 state decide whether the delivery is still eligible.
- Add a Worker `scheduled()` handler as a reconciliation sweep for missed/uncreated workflow instances and maintenance. Use a small number of Cron expressions within the Free allowance; do not make the cron event itself the only record of scheduled intent.
- Preserve the current single-publisher behavior. Add a D1-safe claim/lease or equivalent atomic state transition before publishing each due post so overlapping invocations and retries cannot publish the same post twice.
- Bound batch sizes and per-run external API calls. Make retries and partial failures safe and observable.
- Rework scheduler health reporting because there will no longer be one always-running process heartbeat.

### 5. Rework backups and operational paths

- Replace PostgreSQL `pg_dump` / `pg_restore` commands and filesystem-based Admin backup controls with D1 export/import operations and R2 retention.
- Document export format, restore procedure, backup verification, and safe handling of overdue scheduled posts during restore.
- Adapt health checks, logging, and admin status pages to Worker invocations and Cron execution records.
- Store secrets as Worker secrets/bindings rather than relying on `.env` at runtime. Add a Cloudflare-specific environment example without copying secret values.

### 6. Preserve externally visible behavior

- Keep OAuth callback paths and `BASE_URL` behavior stable where possible; verify each platform's callback requirements against the final Worker domain.
- Preserve login, Google OAuth, API token auth, CSRF protections, webhook delivery, billing webhooks, media URLs, REST API, and MCP routes, with focused compatibility review for each.
- Ensure third-party API calls, Stripe, and platform OAuth work in Workers' fetch-based runtime. Plan an HTTP Mailgun sending adapter with a secret API key for all email classes; document domain verification, delivery failures, and in-app fallback visibility.

## Implementation sequence

1. **Inventory and compatibility spike:** inspect the full source tree, enumerate PostgreSQL schema/query features, route middleware, and native Node dependencies. Build a minimal Worker that renders one existing page and reads/writes one representative D1 record.
2. **Database port:** add D1 schema migrations and data access implementations; port authentication, sessions, posts, accounts, and admin paths in manageable slices.
3. **Request/runtime port:** move routes and templates onto the Worker request model; replace unsupported middleware and filesystem assumptions.
4. **Media port:** add R2-backed upload and range-serving behavior; validate platform media-fetch flows and the chosen file-size ceiling.
5. **Background jobs:** split scheduler functions, implement durable Workflows for per-post delivery, add atomic D1 claims and ambiguous-outcome review, then add Cron reconciliation and bounded maintenance jobs.
6. **Backups and operations:** implement D1 export/restore, R2 retention, health/status reporting, and deployment documentation.
7. **Parity and cutover readiness:** compare Docker and Worker behavior, rehearse data export/import, verify OAuth/webhooks/media/scheduler flows, and prepare rollback steps. Do not switch production traffic until the migration and restore rehearsal succeed.

## Free-tier constraints to design around

- Workers Free currently allows 100,000 requests per day and 10 ms CPU time per request. CPU-heavy image processing and large synchronous work are a poor fit.
- D1 Free currently includes 5 GB total storage, 5 million rows read per day, and 100,000 rows written per day. Daily limit exhaustion can make queries fail until reset.
- R2 Standard currently includes 10 GB-month storage, 1 million Class A operations, 10 million Class B operations, and free egress. Usage beyond allowances can incur charges if billing is enabled.
- Workers Free supports at most five Cron Trigger expressions per account. Jobs must be combined or carefully partitioned.
- Workflows are available on Workers Free, with a published allowance of 3,000 steps/day, 1 GB-month of state, 100,000 executions/day shared with Workers, and up to 100 concurrent instances. Include long-lived delivery instances and retries in the usage budget.
- Free Queues retain messages for 24 hours, so Queues are not the source of truth for posts scheduled days or months ahead. D1 remains authoritative; Workflow sleeps and Cron reconciliation are the selected delivery design.
- D1 Time Travel is available at no additional cost with a 7-day restore window on Workers Free. It is a recovery aid, not a substitute for tested exports and restore procedures.
- Cloudflare Containers are not part of the zero-cost target; the existing Docker image cannot be deployed unchanged as a free Worker.
- Social platforms, Stripe, email providers, domain registration, and any external database are outside Cloudflare's free service allowances.

Free-tier numbers change. Recheck official Cloudflare pricing and limits immediately before implementation and before production cutover.

## Risks and verification items

- **Scope:** the SQL and request-runtime changes are a substantial port. A minimal spike should establish feasibility before broad route conversion.
- **Database compatibility:** Postgres behavior is embedded throughout the app and scheduler; a complete query inventory is needed before sizing the rewrite.
- **Media upload path:** current disk staging and 200 MB limit do not map directly to Workers. Plan streamed Worker-to-R2 image uploads with a 25 MB file cap and application-enforced storage/operation budgets.
- **Scheduler delivery guarantees:** durable scheduling can survive app deployments and request interruptions, but cannot make a social platform available. Persist due work, retry transient errors with backoff, detect overdue jobs, and route ambiguous outcomes to manual review.
- **Quota pause behavior:** when an R2 or D1 budget prevents a media-dependent publish, retain it in a recoverable `budget_hold` state and alert the operator. Resume eligible work when the budget resets; never delete or permanently fail the scheduled record solely because a quota was reached.
- **Session persistence:** choose a D1-backed session design, cookie/session rotation rules, and cleanup strategy.
- **Native dependencies:** verify `sharp`, filesystem use, SMTP replacement, child-process backup tooling, and any other Node-only behavior against the selected Worker runtime.
- **Migration and rollback:** specify how live PostgreSQL data, sessions, uploaded media, and queued posts move, and how traffic can be returned to Docker without double-publishing.
- **Always-on expectation:** Cloudflare's service availability, free quota exhaustion, external APIs, and email delivery are dependencies. Design for durable recovery and alerts, while documenting the limits of any uptime or publish-time guarantee.
- **Single-user workload:** the initial forecast is one user's daily planning and a few social accounts. Keep the design small and understandable, while defining scale-out seams for future users and usage.

## Initial acceptance criteria

- A Worker deployment can serve the existing sign-in and main application flows with D1-backed data and sessions.
- Existing PostgreSQL data can be migrated with a documented, rehearsed procedure.
- Media uploads, reads, range requests, copies, and cleanup work through R2 within documented size constraints.
- Scheduled posts publish once under retries and overlapping invocations; recurring posts, metrics, cleanup, and webhooks retain expected behavior.
- D1 export/restore is documented and tested, and no recovery step depends on `pg_dump`, a persistent local filesystem, or a Docker host.
- Docker deployment remains usable during development and as a documented rollback path.
- Usage monitoring can show proximity to Worker, D1, R2, and Cron free allowances.
- R2 uploads stop before the configured storage and operation budgets are reached; the user sees a clear capacity message rather than silently moving into paid usage.
- If a platform publish result is ambiguous after timeout, the post enters a review-required state and an email alert is attempted through the planned Mailgun HTTP API; the system does not automatically republish an ambiguous post.
- The plan documents a structured expansion path for every feature, including any feature deferred from the first Cloudflare release.

## Reference files reviewed

- `index.js`, `app.js`, `scheduler.js`
- `db/pool.js`, `db/migrate.js`, `db/migrations/`
- `lib/storage.js`, `middleware/upload.js`, `routes/uploads.js`
- `lib/backup.js`, `scripts/backup.js`
- `package.json`, `Dockerfile`, `docker-compose.yml`, `.env.example`

## Cloudflare references

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Workers Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Hono on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/)
- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)
- [Workflow pricing](https://developers.cloudflare.com/workflows/reference/pricing/)
- [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/)
- [Workflow sleeping and retries](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)
- [D1 Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/)
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [Cloudflare `cf` CLI](https://developers.cloudflare.com/cf/)
- [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/)

## Detailed code inventory and migration notes

This section records the known touchpoints from the current repository review. The implementation inventory should be refreshed against the exact source revision before work starts.

| Area | Current implementation | Cloudflare work |
| --- | --- | --- |
| Runtime startup | `index.js` validates `process.env`, imports `app.js`, calls `app.listen()`, then starts `scheduler.js`. | Add a Worker module entry and bindings. Split initialization from serving; avoid process startup/shutdown assumptions in request handling. |
| Route and middleware stack | `app.js` composes Express routers and middleware, EJS views, `express-session`, Passport, CORS, Helmet, Multer, and CSRF. | Inventory middleware one by one. Select a Workers-compatible router/request adapter or port handlers. Validate cookie, body parsing, multipart, redirect, streaming, and error semantics. |
| Database connection | `db/pool.js` exports a singleton `pg.Pool` using `DATABASE_URL`. | Replace Worker-path pool access with D1 binding calls. Do not create a network PostgreSQL connection per request as a substitute: that would retain a paid external database dependency and would not meet the all-Cloudflare free goal. |
| Schema migrations | `db/migrate.js` reads ordered SQL files from disk, tracks filenames in `schema_migrations`, and runs transactional PostgreSQL migrations. | Add versioned D1 SQL migrations and run them through the selected Cloudflare `cf` CLI/deploy workflow. Convert types, defaults, indexes, foreign keys, and constraints; replace automatic container-start migration with an explicit, repeatable deployment step. |
| SQL conventions | Queries use `$1` parameters, `NOW()`, PostgreSQL arrays and `ANY`, JSONB values, `ILIKE`/PostgreSQL operators where present, error code `23505`, and multi-statement transactions. | Build an inventory and conversion checklist. Use D1 prepared statements and positional `?` bindings; replace array predicates with bounded `IN` placeholders or join/temp-table patterns, timestamp expressions with SQLite equivalents, JSONB operators with SQLite JSON functions or application-side handling, and Postgres error-code branching with adapter-level errors. Verify `RETURNING`, transaction batching, and locking assumptions individually. |
| Persistent sessions | `express-session` plus `connect-pg-simple`; Passport serializes user IDs and loads current account state from PostgreSQL. | Choose a supported cookie/session design. If retaining server-side sessions in D1, implement and secure the store, TTL cleanup, and session rotation. Consider Durable Objects only if their free-tier storage and request limits fit; avoid putting session tokens in eventually consistent KV without reviewing revocation and consistency needs. |
| Scheduler and publish safety | `node-cron` schedules jobs inside the single app process. Due posts are selected and updated to `posting` before calls to social APIs. | Scheduled handlers can overlap or be retried, so the claim step must be an atomic conditional update with a lease/claim token and stale-claim recovery. Consider that a timeout after a platform accepts a post but before D1 records success can still create a duplicate; add adapter idempotency where APIs support it and explicit recovery states where they do not. |
| Upload ingest and image work | Multer writes up to 200 MB to `public/uploads`; storage helpers can then push it to an S3-compatible bucket. `sharp` is used for image preparation. | Workers have no persistent writable filesystem. Stream uploads through the Worker to enforce pre-write size and operation budgets; first release accepts images up to 25 MB. Replace `sharp` or delegate image transformation only if the free allowance and output meet platform requirements. |
| Media delivery | `routes/uploads.js` streams private S3 objects through the app, including Range/Content-Range headers, and has local-disk fallback. | Implement R2 object reads with correct `HEAD`, `GET`, `206`, `416`, ETag, MIME, cache, and range behavior. Remove disk fallback in the Worker path while keeping Docker storage behavior intact. Keep UUID validation and never serve the backup prefix. |
| Backups and admin controls | `lib/backup.js` invokes `pg_dump`, writes local custom-format files, copies them to S3, lists/deletes them in Admin, and retains local and bucket copies. | Use D1 Time Travel for short-window recovery and an explicit D1 export mechanism for weekly R2 snapshots. Store export artifacts in a private R2 prefix and implement retention and restore documentation. Rework Admin controls so restore remains an operator action, not an HTTP request. |
| External integrations | OAuth, SMTP/Nodemailer, Stripe, social adapters, webhooks, MCP, and an Anthropic SDK dependency are present. | Audit each dependency's use of TCP, Node built-ins, filesystem, streaming, and request duration. Replace SMTP sending with Mailgun's HTTPS API. Confirm social platform upload protocols and OAuth callback domains. |
| Static assets and content | Express static files, EJS templates, vendored FullCalendar assets, and Markdown blog content are loaded from the app tree. | Bundle templates/content or place static files in Worker assets. Check dynamic path reads and `fileURLToPath` assumptions. Preserve content licensing and verify production bundle size/startup constraints. |
| Admin health and telemetry | `/health` queries Postgres and reports a scheduler heartbeat; logs use Pino. Admin pages inspect version, storage, backup, and scheduler status. | Use a lightweight D1 health query plus deployment/runtime logs. Persist job-run status and last-success timestamps if operators need health state across stateless invocations; bound retention and avoid noisy writes that consume D1 quotas. |

## Work packages and exit gates

The packages below are planning and delivery gates. No implementation should begin until the architecture choices, feature disposition, failure semantics, migration procedure, and cost budget have been written down and reviewed as one coherent design.

### WP0 — Verify source and establish baseline

- Record the source commit used for the Cloudflare branch.
- Enumerate every query, migration, PostgreSQL type/operator, and transaction boundary; include routes, `lib/`, `mcp/`, and `scripts/` rather than only the scheduler.
- Inventory `process`, `fs`, `path`, `child_process`, `Buffer`, sockets, streams, native packages, timers, and dynamic imports.
- Capture baseline behavior for authentication, one OAuth flow, post CRUD, cross-post publishing, media upload/delivery, recurring posts, metrics, billing webhooks, REST, and MCP.
- **Exit gate:** a written compatibility matrix identifies supported, replace, and defer decisions for each runtime dependency and user-visible feature.

### WP1 — Runtime proof of concept

- Create a separate Cloudflare entry point and `cf` project configuration without changing Docker startup.
- Serve one static asset, one rendered page, and one JSON/API route from Workers.
- Exercise cookie/session behavior, request bodies, redirects, and error handling in local `cf dev` and a non-production Cloudflare environment.
- **Exit gate:** demonstrate the chosen routing/rendering strategy on Workers without relying on a listening TCP server or persistent local files.

### WP2 — D1 schema and data adapter

- Create D1 schema from the current ordered migrations and maintain an explicit mapping from each existing table/index/constraint.
- Add D1 data methods behind a small interface; avoid building a generic SQL translation layer unless the inventory proves it is practical.
- Port one vertical slice at a time, starting with users/auth and then social accounts/posts/media metadata, followed by admin, analytics, billing, and audit/event data.
- Define concurrent request behavior and transaction boundaries using D1-supported atomic batches/transactions.
- **Exit gate:** all ported feature flows run against D1, and migration checks prove row counts, uniqueness, foreign keys, and key query results against a migrated fixture.

### WP3 — Authentication, sessions, and request security

- Select the runtime/router and middleware replacements before moving all routes.
- Preserve password hashing, Google OAuth, suspended-account handling, CSRF, API bearer tokens, rate limits, CORS, and secure-cookie behavior.
- Implement session expiry and logout/revocation semantics; test concurrent requests and session fixation defenses.
- **Exit gate:** auth/security behavior is documented and exercised with browser flows and API requests on the Worker deployment.

### WP4 — R2 uploads and media processing

- Define the upload protocol, ownership metadata, allowed content types, 25 MB image maximum, and abandoned-upload cleanup.
- Enforce a 7 GB media cap and an 8 GB total R2 cap including backups; pause uploads before a cap, and show current and remaining capacity in Admin.
- Keep the bucket private and upload through the Worker using a streaming body, Worker R2 binding, and D1 reservation/accounting before the write. Defer presigned browser uploads because a reusable URL would weaken the first-release operation guard.
- Port copy, delete, media URL generation, private retrieval, range reads, and backup-prefix protection.
- **Exit gate:** image upload/read/copy/delete succeeds within configured caps; `HEAD` and range responses are correct for stored media. Video upload support is deferred to its roadmap item.

### WP5 — Scheduled jobs and publish state machine

- Separate each job from `startScheduler()` and make each job safe to invoke more than once.
- Implement one durable Workflow per individual post delivery, with D1 as authoritative state and `sleepUntil` for future due times. Use Cron Trigger reconciliation to discover due D1 records with missing workflow IDs or stale claims; run maintenance on the same small schedule set.
- Limit workflow creation and retry budgets to stay within the Free plan's daily steps, state, and concurrency allowances. A post scheduled beyond Workflows' one-year maximum sleep horizon remains in D1 and is dispatched into a Workflow within that horizon.
- Design `scheduled` → `posting` claim, lease expiry, success, retryable failure, permanent failure, and manual-retry transitions.
- Add a `review_required` outcome for uncertain platform acceptance. Send a Mailgun API alert with enough context and a direct admin link; if email delivery fails, retain the review state and surface it persistently in the app.
- If the R2 read-operation guard or D1 free quota blocks delivery, preserve media-dependent posts in `budget_hold`, alert, and resume after the limit resets instead of marking them permanently failed.
- Make the due-post sweeper catch up posts after Worker deployment/runtime interruptions. Define grace periods, ordering, per-platform rate limits, and behavior for posts that are too late to publish as intended.
- Check each platform's publish/idempotency options and make duplicate risk visible in logs/admin status.
- **Exit gate:** simulated concurrent cron runs and injected timeouts do not silently lose work; tests cover the accepted duplicate/retry semantics.

### WP6 — Data migration, backup, and rollback

- Define PostgreSQL export-to-D1 import mapping, including timestamp/timezone, JSON, booleans, IDs, nulls, and sequences/identity values.
- Migrate media objects into R2 and verify each `post_media` reference resolves before cutover.
- Plan a write freeze or delta-sync window; queues and OAuth sessions need explicit treatment. Existing sessions should likely be invalidated at cutover rather than translated.
- Rehearse backup restore into a clean D1 database and restore the app to service before any production DNS change.
- Prepare rollback steps that prevent the Docker scheduler and Worker scheduler from publishing simultaneously. Define which database becomes authoritative during rollback.
- **Exit gate:** restore rehearsal meets a declared recovery point and recovery time, and a rollback rehearsal avoids data divergence and duplicate sends.

### WP7 — Staged deployment and cost guardrails

- Deploy to a temporary `workers.dev` hostname first, then a staging custom domain, and only later the production hostname.
- Add usage review procedures for Worker requests/CPU, D1 reads/writes/storage, R2 storage/operations, and cron usage.
- Enable billing alerts/spending controls where available and document which limits hard-fail versus which can generate charges.
- Keep Docker image releases and backup copies during the transition window.
- **Exit gate:** no production cutover until functional parity, migration, restore, OAuth callbacks, media retrieval, and scheduler ownership are all checked off.

## Feature roadmap and expansion structure

The first Cloudflare release should target the single-user workload, but every feature must have a planned disposition. “Later” means it is included in the roadmap with an explicit dependency and acceptance criteria, not silently dropped. The detailed plan should assign each item one of **First release**, **Later release**, or **Not applicable to a single-user self-hosted deployment**, and name any behavior that changes.

| Feature area | First Cloudflare release plan | Structured expansion path |
| --- | --- | --- |
| Sign-in, Google OAuth, account security, sessions | Preserve the primary user's login, secure session, password reset/verification, and OAuth behavior supported by the chosen Worker runtime. | Add multi-user invitations, roles, session administration, and account recovery flows if the deployment later needs additional users. |
| Social account connections | Preserve OAuth and token refresh for the user's enabled social platforms; document platform-specific limitations. | Add or revise adapters as platform APIs change; isolate adapter capabilities and permissions so new platforms do not change the core scheduler. |
| Composer, drafts, calendar, cross-post groups | Keep the existing create/edit/reschedule flows, per-platform options, and media associations. | Add bulk editing, richer calendar interactions, and new platform options behind adapter/feature boundaries. |
| Scheduled and recurring posts | Durable D1-backed queue, atomic claims, retries for known transient failures, overdue-job catch-up, and manual review for ambiguous outcomes. | Increase throughput with bounded batches/queues, richer retry policies, and multi-account scheduling only after quotas and delivery semantics are re-evaluated. |
| Media upload and delivery | Private R2 objects, Worker-streamed image uploads up to 25 MB, range support, retention cleanup, 7 GB media/8 GB total-storage caps, and fail-closed operation budgets. | Video uploads, resumable multipart uploads, additional transforms, or higher caps require their own limits and acceptance criteria. |
| Metrics and analytics | Preserve supported platform metrics if they fit Worker duration and free D1 read/write budgets; define a reduced refresh cadence if needed. | Add metrics sources and reporting after quota impact is measured; batch and retain data within configurable limits. |
| Notifications and email | Use Mailgun HTTP API for verification, password recovery, and admin alerts; keep its API key in Worker secrets. Ensure ambiguous publishing alerts remain visible in-app if email fails. | Add provider abstraction and a second provider or delivery diagnostics if operational needs justify it. |
| REST API and API tokens | Preserve documented API routes and bearer-token security where feasible in the Worker router. | Version new endpoints without breaking clients; add scopes/rotation and rate limits if integrations grow. |
| MCP server | Inspect the current remote MCP transport and auth compatibility. Include it in the feature disposition; preserve it in first release if Worker transport is feasible, otherwise explicitly plan its later Worker-compatible transport. | Expand tools/resources while keeping authorization aligned with the REST API token model. |
| Outbound webhooks | Preserve publish/failure events if bounded delivery and retries can be implemented safely. | Add delivery history, signatures, replay controls, and backoff behavior in a later phase if users need stronger integration operations. |
| Admin and operations | Keep the single-instance operator controls needed for platform availability, storage caps, job health, review-required posts, backups, and usage visibility. | Add multi-user administration, richer audit reporting, and configurable service policies if the deployment expands. |
| Billing and plans | Hosted SaaS subscription billing is out of scope for this one-user self-hosted deployment; disable customer checkout and plan enforcement in the self-hosted profile. | Reintroduce Stripe plans only if the deployment expands to hosted/multi-user service. |
| Blog/public site and legal pages | Keep necessary public and legal pages as static content; defer blog editing and broader public-site features from the self-hosted first release. | Add content publishing/site administration if the instance later needs them. |
| Backups, restore, upgrades | Use D1 Time Travel (7 days on Free), weekly D1 exports to private R2, four retained snapshots, pre-migration exports, restore rehearsal, and schema-upgrade instructions. | Add off-account copies or longer retention only with a separately reviewed storage/cost policy. |
| Logging, health, alerts | Add persistent last-success/failure state for critical jobs, a health view, usage-cap warnings, and Mailgun alerts where configured. | Add external monitoring integrations and richer diagnostics as needed, without making observability writes exhaust D1 quotas. |

### Required plan artifacts before implementation

The planning phase is complete only when the repository contains:

1. A Workers/D1/R2 architecture decision record, including exact runtime/router, binding design, and local development approach.
2. A feature disposition matrix covering every current user-facing feature and route, with first-release scope, deferred scope, behavior changes, dependencies, and acceptance criteria.
3. A PostgreSQL-to-D1 schema/query conversion inventory and a representative migration mapping.
4. A scheduler state machine covering outages, late posts, retryable errors, ambiguous platform acceptance, manual review, and Mailgun alert failure.
5. An R2 upload/storage budget policy with conservative limits, reservation/headroom rules, hard-stop behavior, and admin-facing messaging.
6. A Mailgun design for API-key storage, sender/domain setup, templates, retry policy, provider quota assumptions, and fallback visibility.
7. A data/media migration, backup/restore, cutover, and rollback runbook.
8. A verification plan covering feature parity, security, free-tier usage, recovery, and staging before production cutover.

## Availability and publish reliability target

“Always available” and “scheduled posts should never fail due to downtime” are treated as design goals, not an absolute guarantee. The application should not lose a due post when a Worker deployment or invocation is interrupted: persist intent in D1, use leases and idempotent state transitions, scan overdue work on the next scheduled invocation, and surface any post outside its timing grace period. App downtime must not be the reason a scheduled record disappears or remains permanently stuck.

There are limits the application cannot remove: Cloudflare account/service incidents, D1 or Worker free quota exhaustion, a disabled deployment, social platform outages/rate limits, expired/revoked OAuth credentials, and email-provider failure. The plan must define how each is detected and recovered. A platform timeout with unknown acceptance is **not** blindly retried: put the item into `review_required`, send a Mailgun API alert, retain an in-app review item if sending fails, and require the operator to confirm whether to retry.

For an always-on production expectation, no production cutover should occur until the free-tier quotas have measured headroom for the expected one-user workload and usage checks are in place. If a hard Cloudflare limit is reached, the system should preserve queued work and clearly report a paused/degraded state rather than discard posts or incur an unplanned paid deployment.

## Cost guardrail policy

- Keep Workers on the Free plan; do not use Containers or deploy a paid Workers configuration for this target.
- Make all app-originated R2 access go through the Worker or a narrowly scoped upload flow that the app accounts for. Prevent arbitrary public bucket access.
- Enforce a configurable per-file maximum and conservative total-byte cap below the current R2 free storage allowance. Refuse new uploads before the cap; do not automatically upgrade, add capacity, or switch providers.
- Track application-controlled R2 operations and apply conservative budgets with headroom. If accounting is unavailable or inconsistent, pause new uploads until usage is confirmed.
- Keep D1 and Worker request/query work bounded and optimized. Quota exhaustion should pause/defer background work where possible and preserve durable queue state.
- Recheck Cloudflare pricing and quota behavior before deployment. Application guards cannot cap every account-level charge if other workloads share the Cloudflare account; use a dedicated account or verify account-level billing controls for the deployment.
- Use the selected 25 MB per-image, 7 GB media, 8 GB total R2, 100,000 Class A/month, and 1,000,000 Class B/month app caps as initial settings. Confirm current Cloudflare billing definitions before implementation and keep the caps below free allowances.

## Confirmed deployment requirements

- **Deployment model:** one self-hosted instance, initially used by one user with a few connected social accounts.
- **Planning priority:** finish and review a complete implementation plan before changing application code. The feature roadmap must document a structured expansion path for every current feature.
- **Availability:** once production is cut over, prioritize continuous access and ensure app downtime does not lose queued posts. Use durable job state, catch-up, and recovery; document external service and free-quota limits honestly.
- **Media and cost:** use R2, with explicit app-side caps and fail-closed behavior intended to prevent charges from application-controlled usage.
- **Email:** use a Mailgun HTTP API adapter for all email classes, with its API key stored as a Worker secret. Plan on the expected sending volume staying below provider limits, as specified by the user.
- **Ambiguous publish timeout:** place the post in manual review and send an email alert; never blindly republish an outcome that may already have succeeded.
- **Expected workload:** one user logging in and preparing future posts daily, scheduling across a few social accounts, and uploading images for later use.

## Planning decisions selected

These defaults resolve the remaining planning choices using the stated one-user workload. They are the basis for the ordered implementation plan.

| Decision | Selected default |
| --- | --- |
| Runtime and UI routing | Hono on Workers. Keep HTML-rendered pages and existing interaction patterns. First test whether EJS templates can be bundled and rendered without filesystem access; if that is awkward, migrate templates to a Worker-compatible renderer as one planned work item. |
| Cloudflare project tooling | Use Cloudflare's current `cf` CLI and its native project configuration because this checkout has no Cloudflare configuration. Keep Docker commands and local Node development separate. |
| Static assets | Workers Static Assets for CSS, JavaScript, vendor bundles, and other immutable files. Dynamic view templates remain bundled with the Worker. |
| Template rendering | Keep EJS in the first release. Bundle template source and includes at build time, render from an in-memory template map, and prohibit runtime filesystem reads. If the minimal proof of concept fails, use Hono JSX as the preselected fallback. |
| Sessions | Implement a custom D1 session table. Generate an opaque cryptographically random cookie token, store only its SHA-256 hash, use `HttpOnly`, `Secure`, `SameSite=Lax`, and a host-only cookie, rotate on login, revoke on logout, and expire/clean sessions daily. |
| Scheduling and delivery | D1 is the durable source of truth. Use one Cloudflare Workflow per post delivery to sleep until the scheduled time, claim/validate state in D1, call the social adapter, and persist results. A Cron Trigger sweeps for missing or overdue work and runs maintenance. Do not use Queues as the long-term schedule store because Free Queues retain messages for only 24 hours. |
| Scheduler reconciliation | Run a one-minute reconciliation trigger plus separate periodic triggers only where needed; keep within the account's five Cron Trigger allowance. The reconciliation sweep catches work missed during deploys or temporary service interruptions. |
| Ambiguous platform timeout | Mark the post `review_required`, stop automatic retries, retain the item in the app, and send a Mailgun email with a link and platform/account context. Retry only after operator review. |
| Email provider | Use Mailgun's HTTPS API for verification, password reset, and operational notifications. Store the API key as a Worker secret. Assume the expected volume remains below Mailgun's sending limits as provided by the user; surface delivery failures in the app. |
| R2 upload method and limits | Stream uploads through the Worker so budget checks cannot be bypassed by reusing presigned URLs. Set maximum image size to 25 MB, media storage cap to 7 GB, and total R2 storage cap (media plus backups) to 8 GB. Reserve the remaining free allowance for rounding and account-level headroom. |
| R2 operation guard | Track app-issued R2 operations; stop writes at 100,000 Class A operations/month and pause nonessential reads/listing at 1,000,000 Class B operations/month. These are 10% of the documented free allowances. Use a dedicated Cloudflare account and show usage in Admin. Recheck billing semantics before coding. |
| R2 cap behavior | Reserve operation budget before each Worker-issued R2 call and count failed attempts conservatively. When the Class B cap blocks media reads, set media-dependent deliveries to `budget_hold`; allow posts without media to continue. Resume held work when the budget resets. |
| Cloudflare quotas | Remain on Workers Free. Add usage and failure visibility for Workers, D1, and Workflows. Do not silently upgrade or queue unlimited work when a free limit is reached; preserve D1 post intent and resume after the limit resets. |
| Backups and recovery | Use D1 Time Travel's free 7-day point-in-time restore as the fast recovery mechanism. Also plan a weekly export into the R2 `backups/` prefix using a dedicated Workflow and the documented D1 export API, with four retained copies bounded by the 1 GB backup allocation. Store the least-privilege Cloudflare API credential as a Worker secret. Take an additional export before schema migrations and production cutover. |
| Production migration | Since downtime during development is acceptable, use a controlled one-time cutover: freeze Docker writes, export and validate D1/media data, disable the Docker scheduler, enable the Worker scheduler, then change DNS. After D1 accepts production writes, do not switch back to stale PostgreSQL; rollback means forward-fix on Workers, or pause both schedulers and run a rehearsed reverse importer before Docker resumes. |
| Recovery target | After Cloudflare service resumes, target that due posts are rediscovered within five minutes and preserved until processed or explicitly moved to review. Target app restoration within one hour after an operator-initiated rollback/recovery. D1 Time Travel offers minute-level restore within seven days; older catastrophic recovery relies on weekly R2 exports. These are operational targets, not Cloudflare uptime guarantees. |
| Media recovery | Keep R2 private and treat D1 metadata plus existing R2 objects as authoritative. Defer destructive object cleanup behind a retention/tombstone window so accidental deletes can be reversed; do not duplicate all media in the first release because it would consume the strict storage budget. |
| Feature scope | Keep features required by a single-user self-hosted workflow in the first release. Treat hosted subscription billing and multi-tenant administration as not applicable to this deployment, but document a later expansion path. |

## Ordered implementation roadmap

Work down this list in order. Each item gets its own design notes, implementation boundary, and acceptance criteria before moving to the next. Dependencies are included in the ordering so early infrastructure work directly enables the highest-impact user flows.

| Order | Feature/workstream | First-release outcome | Expansion path |
| --- | --- | --- | --- |
| 0 | Finish plan and source inventory | Confirm exact repo revision; enumerate routes, dependencies, migrations, SQL features, and current user-visible behavior. Complete feature disposition, budget and recovery policy, and staging/cutover runbook before code changes. | Re-run the inventory whenever upstream changes introduce routes, dependencies, or schema migrations. |
| 1 | Cloudflare app foundation | Add the Hono Worker runtime, Cloudflare `cf` configuration, Static Assets, environment bindings, secret setup, structured logs/traces, local development, and a staging deployment path. Leave Docker intact. | Add preview environments and automated deployment after local/staging parity is reliable. |
| 2 | D1 data layer and schema | Convert core schema/migrations and introduce D1 data access. Add indexes for account, post status/scheduled time, ownership, and cleanup queries. | Add table/retention changes as later features require; retain explicit migration and rollback notes. |
| 3 | Single-user identity and security | Bootstrap one owner account; port sign-in, Google sign-in if compatible, password reset/verification, sessions, CSRF, API tokens, security headers, and rate limits. Disable open sign-up by default after owner setup. | Add invitations and roles only if the deployment later needs more users. |
| 4 | Platform connection management | Port OAuth/connect, token refresh/revocation, account metadata, and disconnect for existing adapters. Verify callback behavior on the Worker domain. | Add or revise adapters individually, with capability checks and platform-specific acceptance criteria. |
| 5 | Mailgun email delivery | Replace SMTP transport with Mailgun HTTPS API for all email classes; store the key as a secret; preserve delivery status and retry policy. | Add a provider abstraction only if the instance later needs a second mail service. |
| 6 | R2 media lifecycle | Port streamed image uploads, metadata, private media reads, byte ranges, copies, delayed deletion/tombstones, retention cleanup, and hard size/storage/operation caps. | Add video uploads, resumable multipart transfers, or additional transforms only after defining platform-specific handling and new cost controls. |
| 7 | Composer, drafts, calendar, cross-post groups | Port post create/edit/delete, draft states, per-platform settings, calendar rescheduling, grouped cross-posts, and media association. | Add bulk operations and richer composer features after parity. |
| 8 | Reliable scheduled publishing | Convert each account-targeted post to durable D1 state plus a Workflow with sleep-until, atomic eligibility claim, adapter publish, retries for definite transient failures, and final status. Add Cron reconciliation/catch-up and persistent `review_required` handling for ambiguous results. | Add throughput only after concurrency, quota, platform-rate, and duplicate-risk budgets are measured. |
| 9 | Recurring posts and recovery | Preserve recurring post creation/next occurrence, missed schedule handling, retry/manual retry, cancel/edit behavior, and restore semantics. | Add richer recurrence rules and per-platform scheduling controls later. |
| 10 | Admin operations and backups | Port operator pages for connected platforms, usage caps, job status, overdue/review-required posts, D1 Time Travel guidance, weekly R2 exports, restore, and app version. Use a least-privilege API secret only for D1 export operations that are not available through a Worker binding. | Add audit/reporting depth and integrations later. |
| 11 | Metrics and analytics | Port available metric refresh and analytics views, with bounded per-run API calls and a cadence that stays within free quotas. | Add sources, retention, and reports after measuring API and D1 consumption. |
| 12 | REST API and webhooks | Port documented API routes/tokens and outbound publish/failure webhooks, with bounded delivery retries and history for this single user. | Add scopes, replay UI, signatures, and richer delivery inspection later. |
| 13 | MCP | Port the remote MCP endpoint if its transport works in Workers and keep it under API-token authorization. | Add tools/resources later without widening authorization. |
| 14 | Blog, public site, and hosted billing disposition | Serve necessary public/legal pages as static content; disable SaaS subscription checkout and customer billing in the self-hosted profile. Document current behavior and future hosted-product port separately. | Reintroduce blog editing or Stripe plans only if the deployment goal expands beyond one self-hosted user. |

### Feature acceptance rule

Before beginning each numbered item, add a short section here naming the source files/routes it touches, dependencies, migration impact, security/cost considerations, and observable acceptance criteria. Mark the item complete only after those criteria are met. Preserve Docker as a working deployment until the roadmap reaches migration and cutover.

## Work tracking checklist

- [x] Confirm source revision and complete dependency/query inventory.
- [x] Complete and review all required plan artifacts before implementation.
- [x] Disposition every existing feature for first release or a named later phase.
- [ ] Complete Workers compatibility matrix and runtime proof of concept.
- [ ] Finalize D1 schema, migration strategy, and session-store design.
- [ ] Finalize R2 upload protocol and media-processing strategy.
- [ ] Specify scheduler claim/lease/retry semantics.
- [ ] Specify D1 backup/restore and production data migration procedure.
- [ ] Verify the selected fail-closed R2 budgets against current billing definitions and implement Mailgun alert/review behavior.
- [ ] Implement parity work behind a separate Cloudflare deployment path.
- [ ] Rehearse migration, recovery, and scheduler-exclusive cutover.
- [ ] Review current free-tier limits and usage forecast before launch.

## Implementation progress

### Work item 0 — source inventory and final planning (complete 2026-11-16)

**Source baseline.** The Cloudflare work is based on upstream Postfalcon commit
`fd3a797cc90bb34c2c1abbe12b4c7b6a7463e56c` (2026-11-16). The existing
Docker-oriented files and local `.env` were preserved. This repository checkout
does not have a usable Git worktree, so that commit identifier is recorded here
as the migration baseline rather than inferred from the local checkout.

**Observed inventory.** The application has 26 route modules, 13 platform
adapter modules, 32 ordered PostgreSQL migrations, and direct `pool.query()`
use in 68 JavaScript source files. The runtime depends on Express, Passport,
`express-session` plus `connect-pg-simple`, `pg`, Multer, node-cron,
Nodemailer, Sharp, AWS S3 support, filesystem access, and child-process backup
tools. The current schema uses `BIGSERIAL`, `TIMESTAMPTZ`, `JSONB`, a UUID
column, PostgreSQL functions/triggers, partial indexes, and `now()` defaults;
the first D1 migration must therefore be a deliberate schema port, not an
attempt to run the PostgreSQL migration files unchanged.

**Compatibility disposition.** The Worker path must replace, rather than
polyfill, the long-running listener, Postgres session store, disk multipart
staging, SMTP, `sharp` transforms, `pg_dump`, and in-process cron. Browser
HTML, CSS, JavaScript, route contracts, OAuth callback paths, API tokens, and
platform adapters are feature-parity targets, subject to an adapter-by-adapter
Worker fetch review. Docker stays the only active full application runtime until
each workload has passed its own acceptance tests.

**Implementation boundary.** The Cloudflare source is isolated in
`cloudflare/`; it has no access to or mutation of the Docker runtime. All
production identifiers and credentials are intentionally absent from version
control. The full architecture, feature disposition, scheduler state policy,
R2 budget policy, Mailgun design, and cutover/rollback rules are documented in
this plan before source changes started.

### Work item 1 — Cloudflare foundation (in progress, started 2026-11-16)

**Files and routes.** Added `cloudflare/cloudflare.config.ts`, the Vite/Cf
project setup, a Hono Worker entry at `cloudflare/src/index.ts`, the initial
`cloudflare/migrations/0001_foundation.sql`, local-secret example, and the
operator README. The only Worker routes are `GET /` (an explicitly isolated
foundation page) and `GET /healthz` (a bounded `SELECT 1` D1 check). A one-minute
Cron Trigger writes a small reconciliation invocation record; it does not
publish anything.

**Dependencies and migration impact.** The new subproject declares `cf`, the
Cloudflare Vite plugin beta, TypeScript, Vite, and Hono. The resolved current
`cf` beta requires Node 22.23+ even though the configuration feature itself is
documented for Node 22.18+; the project therefore pins the safer Node 22.23
minimum. The current development shell is Node 20.19.2, so runtime validation
must occur on a supported Node runtime. An isolated Node 22.23.0 runtime was
used to install the locked dependencies, generate Worker bindings, type-check,
and build successfully; the system Node installation remains untouched so the
existing Docker application is not disrupted. The foundation migration creates only
Cloudflare-specific job/usage/metadata tables and does not alter Docker's
PostgreSQL schema or data.

**Security and cost controls.** The configuration has no account ID, domain, or
secret. It declares only secret placeholders for session and Mailgun keys,
enables structured JSON logs/traces with query-string redaction, and defines the
agreed R2 caps as non-secret configuration. No public R2 access, social
publishing, email, OAuth, or user data route is enabled. The Worker has one
Cron expression, leaving the remaining Free-plan trigger capacity unused.

**Acceptance criteria before marking complete.** On Node 22.18+, install the
subproject dependencies, generate types, type-check, apply the foundation D1
migration to a staging database, and verify `/healthz` and a scheduled run in a
staging Worker. Confirm that the staging worker cannot reach production data or
activate a publishing adapter. These checks cannot run in this checkout until
the Node runtime is upgraded and a Cloudflare staging account is configured.

**Local validation completed.** With Node 22.23.0, `cf workers types`, the
TypeScript type-check, and `cf build --mode staging` all succeeded. The build
contains a 60.7 kB Worker bundle. D1 migration application remains intentionally
blocked pending a real staging database ID and authenticated Cloudflare account;
the CLI correctly rejects a database name where an ID is required.

**Staging resource progress (2026-11-16).** The Cloudflare account connection
is now authenticated. An isolated `postfalcon-staging` D1 database and private
`postfalcon-staging-media` R2 bucket were created in Eastern North America;
D1 replicas are disabled. Migrations `0001`–`0003` applied successfully to
the staging database, and Cloudflare's `PRAGMA foreign_key_check` returned no
rows. The staging D1 binding ID is committed only for the staging configuration;
no production resource has been created. The first staging deploy correctly
rejected placeholder Mailgun/session secrets; the unused secret bindings were
removed rather than storing fake credentials. They will be reintroduced only
alongside the Mailgun and authenticated-session routes.

**Workflow configuration correction (2026-11-16).** The initial Workflow
export requested seven-day retention for errors, which exceeds the three-day
Workflow state/log retention limit on Workers Free. Cloudflare rejected the
Workflow resource while accepting the Worker and Cron changes. Both successful
and failed Workflow instances now retain for three days, matching the Free
limit; durable post state and delivery audit records remain in D1 beyond that
diagnostic window.

**Staging workflow test correction (2026-11-16).** The first direct test
instance safely left its test post scheduled, but its claim step retried because
the runtime did not supply the typed event `instanceId` field. The delivery
engine now derives its deterministic instance ID from the immutable
`postId`/`scheduledFor` payload that is also used when creating the Workflow.
This removes reliance on that runtime field and preserves the same duplicate-
prevention identity across Cron, request, and CLI creation paths. The test
instance will be deleted and recreated after redeployment; it never contacted a
social platform.

**Workflow definition versioning (2026-11-16).** In this Cloudflare account,
an existing named Workflow continued running the Worker code version present
when its definition was created even after a later Worker deploy. The staging
definition is therefore advanced to a deliberate `v2` name for validation.
Production rollout must treat a Workflow code change as a controlled definition
version: deploy the new definition, direct only newly scheduled posts to it,
retain the previous definition until its outstanding instances drain or are
reviewed, then retire it. This prevents a code update from changing an
in-flight post-delivery execution invisibly.

**Staging diagnostic definition (2026-11-16).** The `v2` definition still
reported a generic D1 undefined-value error despite receiving the expected JSON
payload. `v3` adds an explicit pre-bind assertion for every lease-claim
parameter, making the scheduler fail with a precise invariant message if a
runtime boundary removes a value. This guard remains useful production
defense-in-depth; the `v2` test post stayed in `scheduled` and no adapter was
called.

**Handoff state (2026-11-16, work moved from Codex to Claude Code).** The last
Codex step was not logged or deployed: the `v3` diagnostic showed that the
runtime delivers direct-instance input as `event.params` while the generated
types model `event.payload`, so `src/workflows/post-delivery.ts` now reads
`params ?? payload`, and the definition name in `cloudflare.config.ts` was
advanced to `-v4`. `npm run typecheck` passes with that change (Node 24.17.0).
Next steps, in order: deploy staging; create instance `post-999002-0` on
`postfalcon-staging-post-delivery-v4` with
`{"postId":999002,"scheduledFor":0}`; confirm post 999002 ends in
`review_required` with one row in `post_delivery_attempts` and
`publish_attempts = 1`; then delete the staging test rows (users 999000,
social_accounts 999001, posts 999002) and the superseded Workflow definitions
(unsuffixed, `-v2`, `-v3`), whose only instances are that failed test. Applied
to staging D1 so far: migrations 0001–0004. The Cron Trigger is confirmed
writing a `worker_job_runs` row every minute.

**Delivery engine validated on staging (2026-11-16, Claude Code).** Two more
defects surfaced after the handoff note. `-v4` errored because an instance
created with `cf workflows instances create --params` receives its input as a
JSON-encoded string; `parseDeliveryParams()` in `src/lib/delivery.ts` now
accepts an object or a string and rejects anything without integer
`postId`/`scheduledFor` (`-v5`). `-v5` then moved post 999002 to
`review_required` but errored with "Lost delivery lease" and wrote no audit
row: D1's `meta.changes` also counts rows written by triggers, and
`posts_set_updated_at` fires when an update lands in the same second as the
claim, so the single-row check saw 2. Reproduced in local SQLite. Fix (`-v6`):
ownership checks on `posts` read `RETURNING` instead of `meta.changes`
(`recordWorkflowInstance`, `markReviewRequired`, `releaseExpiredDeliveryLeases`),
and `markReviewRequired` writes its audit row and releases the lease in one
`batch()` transaction, so a step retry can never run against a half-applied
transition. Rule for later repositories: never use `meta.changes` on a table
that has a trigger. Staging result on `postfalcon-staging-post-delivery-v6`:
the test post was reset to `scheduled` with no instance id, the Cron Trigger
created instance `post-999002-0` itself (trigger source `binding`), the
instance finished `complete`, and the post ended `review_required` with
`publish_attempts = 1`, no lease, and two `post_delivery_attempts` rows
(`claimed`, `review_required`). No adapter was called.

**Staging cleanup (2026-11-16).** Deleted the staging test rows (users 999000,
social_accounts 999001, posts 999002 and its attempt rows) and the superseded
Workflow definitions (unsuffixed, `-v2` to `-v5`; `cf workflows delete <name>
--force`). Staging D1 now has no users, accounts, posts or attempts; `-v6` is
the only definition and `/healthz` returns ok. The one completed `-v6` test
instance expires with its 3-day retention.

### Work item 2 — D1 data layer and schema (in progress, started 2026-11-16)

**Files and data model.** Added `cloudflare/migrations/0002_core_schema.sql` as
the D1 baseline. It consolidates the effective end state of PostgreSQL
migrations 001–032 instead of replaying incompatible `ALTER TABLE`, PL/pgSQL,
and PostgreSQL type syntax. The baseline retains current application records
(users, social accounts, posts, media, tokens, events, settings, invites,
webhooks, alerts, and errors), and adds D1-only `sessions`, `email_deliveries`,
R2 metadata, and durable-delivery fields.

**Delivery-safety changes.** A post now permits `review_required` and
`budget_hold` states and persists a Workflow instance ID, a lease token/expiry,
attempt count, and review reason. The schema includes partial indexes for due,
claimed, and review-required work. Existing PostgreSQL trigger behavior is
replaced by SQLite triggers for `updated_at`, first-owner initialization, and
clearing a reconnect flag after token replacement. Timestamp values are stored
as UTC Unix seconds and JSON is validated JSON text; the forthcoming importer
must convert PostgreSQL values explicitly.

**Verification completed.** Both Cloudflare migrations apply cleanly to a
fresh local SQLite database, `PRAGMA foreign_key_check` reports no violations,
and the resulting schema contains 22 tables. This is a syntax and relational
integrity check only; Cloudflare D1 application and imported-data verification
remain required.

**Acceptance criteria before marking complete.** Implement and test D1 query
repositories for identity, posts, media, accounts, settings, and the scheduler;
write the explicit PostgreSQL export/import converter with row-count and
referential-integrity validation; apply this schema to a staging D1 database;
and exercise a representative migrated account. No production data will be
copied until the cutover rehearsal work item.

### Work item 6 — R2 safety primitive (partial prerequisite, started 2026-11-16)

This is intentionally a narrow prerequisite rather than activation of the media
feature out of roadmap order: the storage cap is a non-negotiable safety
invariant, so its accounting is implemented before any later upload route can
call R2. No media route, bucket access, or public object serving is enabled.

**Files and behavior.** Added `cloudflare/migrations/0003_r2_budget.sql`,
`cloudflare/src/lib/r2-budget.ts`, and `cloudflare/src/lib/r2-media.ts`. The
guard requires a positive `Content-Length`, rejects files above 25 MiB, streams
rather than buffers the body, reserves capacity before an R2 call, and keeps
R2 private. The caller must use a server-generated, namespaced key and remain
authenticated; the future route will enforce both requirements.

**Correct accounting model.** `r2_budget_state` is a single D1 row, so one
conditional update atomically enforces the current storage limits (7 GiB media,
8 GiB total) and the monthly Class A/Class B limits (100,000/1,000,000).
Operation counters reset when the UTC month changes; storage counters do not.
Failed/cleanup operations remain charged conservatively, while confirmed R2
object removal releases only storage bytes. An inconsistent accounting state
throws and pauses further uploads instead of risking an unbounded write.

**Verification completed.** The third migration applies cleanly with the D1
baseline in local SQLite. The conditional update was exercised for an initial
reservation, a new UTC month (operation counters reset while storage remains),
and a confirmed-storage release; foreign-key integrity remains clean.

**Remaining acceptance criteria.** Add authenticated image-only upload,
private range reads, media metadata persistence/copy/tombstone cleanup, D1
budget state display, D1-worker runtime tests for concurrent reservations and
stream failure, and staging-R2 verification before any media feature is marked
complete.

### Work item 3 — single-user identity and security (in progress, started 2026-11-16)

**Files and behavior.** Added `cloudflare/src/lib/sessions.ts`. It creates
32-byte cryptographically random opaque session tokens, stores only an HMAC-
SHA-256 token value in D1, records expiry/revocation/last-seen information, and
binds the optional user-agent only as a keyed hash. The cookie is host-only by
omitting `Domain`, has the `__Host-` prefix, `Path=/`, `HttpOnly`, `Secure`, and
`SameSite=Lax`; login will rotate it and logout will revoke it.

**Security boundary.** This primitive uses Web Crypto and has no mutable
request state. It does not expose a login, sign-up, OAuth, reset, API-token, or
CSRF route yet, so it cannot accidentally open the isolated Worker before
password migration, owner bootstrap, and rate-limit behavior are implemented.
The per-minute maintenance handler will use its bounded session cleanup once
the job runner is expanded.

**Acceptance criteria before marking complete.** Test token creation, lookup,
expiry, revocation, cookie flags, and first-owner bootstrap in the Workers
runtime; add protected login/logout/bootstrap routes, existing bcrypt password
hash compatibility, CSRF enforcement for cookie-authenticated mutations,
Google-OAuth callback verification, API-token authentication, and rate limits.
Keep open registration disabled after the one owner is created.

**Identity routes implemented locally (2026-11-16, Claude Code).** Added
`src/lib/{auth,crypto,csrf,passwords,rate-limit}.ts`, `src/routes/auth.ts`,
migration `0005_rate_limits.sql`, security headers (CSP etc.) on every
response, and `no-store` on `/api`. Routes under `/api` mirror the Docker
paths: `GET /csrf-token`, `GET|POST /setup` (owner bootstrap guarded by the
`SETUP_TOKEN` secret, single atomic INSERT-WHERE-NOT-EXISTS), `POST /users`
(always 403), `/auth/login|logout|me|change-password|api-token`. Sessions are
HMAC-hashed opaque cookies (`last_seen_at` refreshed at most every 5 min);
CSRF is a signed double-submit token, exempt for Bearer requests; auth routes
are limited to 10 per 15 min per client address (D1 fixed window, address
stored only as a keyed hash; purged every 15 min by Cron). New passwords use
PBKDF2-SHA256 at 100,000 iterations (the Workers maximum); imported bcrypt
hashes still verify and are upgraded on first login. Declared secrets
`SESSION_SECRET` and `SETUP_TOKEN` in the config. Verified locally with
`cf dev`: unauthenticated 401, missing CSRF 403, setup once then 409, sign-up
403, bad/good login, logout revokes, Bearer token auth, 429 after 10 attempts.
**Not done / not deployed:** staging has neither the secrets nor migration 0005
(apply with `npm run d1:migrate:staging`, then set both secrets, then deploy);
password reset and verification wait on Mailgun (item 5); Google sign-in and
account deletion not ported; the Worker has no login page yet (static assets
come with the UI port), so the API is exercised with curl.

### Work item 4 — platform connection management (first slice, 2026-11-16)

**Staging deployed first.** Migration `0005` applied, secrets supplied with
`cf deploy --secrets-file .staging.vars` (git-ignored, mode 600; the config
declares them required, so a deploy without them is refused). Staging reports
`/api/setup` `needed: true`: no owner account exists there yet.

**This slice.** `src/routes/accounts.ts`: `GET /api/social-accounts`,
`DELETE /api/social-accounts/:id` (also mounted at `/api/v1/…`, session or
Bearer). No create route: every account comes from a platform's own connect
flow. Delete refuses with 409 when the account's posts have R2-backed media,
because the cascade would orphan objects before the media lifecycle (item 6)
exists. `src/routes/connect.ts`: `POST /api/bluesky/connect` (handle + app
password, verified by `createSession`) and `POST /api/telegram/connect` (bot
token + channel, verified by `getMe`/`getChat`); 10 s timeouts, 502 when the
platform is unreachable. Single owner, so no plan limits. Verified locally:
bad credentials rejected by the real Bluesky/Telegram APIs, list/delete on a
seeded row, 404 for a missing id, 401 unauthenticated.

**Remaining for item 4.** OAuth connect/callback flows (Mastodon, Facebook/
Instagram, Threads, YouTube, TikTok, Pinterest, LinkedIn, X) on the Worker
domain, token refresh/revocation (YouTube `revoke`), `needs_reconnect` marking
(`lib/reconnect.js` equivalent), per-platform settings (Pinterest board,
TikTok/YouTube options), and the platform enable/disable registry. Publish
adapters stay with item 8.

**Mastodon OAuth (2026-11-16).** Migration `0006_oauth_state.sql` (applied to
staging) adds `oauth_states` (state stored only as SHA-256, bound to user and
platform, 10-minute expiry, consumed with `DELETE … RETURNING` so it works
once; purged by the 15-minute Cron) and `mastodon_apps.redirect_uri`.
`src/lib/oauth.ts` (state helpers, `sanitizeUrl`), `src/lib/accounts.ts`
(`upsertAccount`, reconnect keeps the row), `src/routes/oauth.ts`:
`GET /api/mastodon/connect?instance=` registers a client per instance (and
re-registers when the Worker origin changes, since a registration is valid for
one redirect URI), `GET /api/mastodon/callback` verifies the state, exchanges
the code, reads `verify_credentials`, stores the account, redirects to
`/accounts`. The redirect URI comes from the request origin, so no domain is
configured. IP-address and single-label hosts are rejected; outbound calls have
a 10 s timeout and never follow redirects (Workers needs `redirect: "manual"`).
Verified locally: invalid instance 400, bad state 400, connect redirects to
mastodon.social with a fresh registration. The callback happy path needs a real
authorization and is not exercised yet; there is no `/accounts` page on the
Worker until the UI port.

**Blocker for the other OAuth platforms.** Facebook/Instagram, Threads,
YouTube, TikTok, Pinterest, LinkedIn and X each need a developer app's client
id/secret supplied as Worker secrets (and a registered callback URL on the
final domain). Since a deploy is refused while a declared secret is unset, they
are deferred until those credentials exist; the code can be written against the
Mastodon pattern at any time. Work continues on credential-free items (6, 7, 8).

### Work items 6, 7, 8 — media, posts and publishing, first slices (2026-11-16)

**Media (6).** Migrations `0007_media_files.sql` (object registry; posts point to
objects through `post_media.media_file_id`, so cross-posts share one R2 object
instead of copying it) and `0008_publish_started.sql`, both applied to staging.
`POST /api/v1/media` takes the raw image as the body (jpeg/png/webp/gif, 25 MiB,
`Content-Length` required, streamed through `FixedLengthStream`, budget reserved
before the R2 put). `GET|HEAD /uploads/<uuid>.<ext>` is public like the Docker
app's, serves ranges, and spends one Class B operation per read (503 once the
month's budget is gone). A 15-minute maintenance pass deletes objects nothing
references after a 24 h grace: it removes the `media_files` row first (so a post
cannot attach it concurrently), then the object, then releases the storage
budget. Account/post deletion therefore needs no media code. Not done: video,
resumable uploads, magic-byte sniffing (type is the declared, allow-listed
`Content-Type`, served `nosniff`), D1 budget view.

**Posts (7).** `/api/posts` and `/api/v1/posts` (JSON only; uploads attach by
`media_ids`, a deliberate change from the Docker multipart create): create with
one or many channels (cross-post group), draft/schedule/`publish_now`, repeat
fields stored, per-post TikTok/YouTube settings validated, alt text, list with
status/account filters, get, patch, delete. Clients can set only
draft/scheduled/canceled; posting/posted posts are locked (409); changing the
time or status clears `workflow_instance_id` so reconciliation binds a fresh
Workflow instance and the old one's claim no longer matches. Known gap for item
8: the instance id is `post-<id>-<scheduledFor>`, so rescheduling a post back to
a time whose earlier instance already finished would reuse a finished instance;
add a schedule revision to the id before relying on reschedule-to-same-time.

**Publishing (8).** Adapters in `src/platforms/` for Mastodon, Telegram and
Bluesky, with a failure taxonomy (`types.ts`): `transient` (nothing posted;
retried up to 3 attempts with backoff, then `failed`), `rejected` and `auth`
(`failed`; `auth` also sets `needs_reconnect_at`), `ambiguous` (timeout, dropped
connection, 5xx or unparseable reply on the final create → `review_required`,
never retried). The workflow (`-v7`) writes `posting_started_at` before
contacting the platform, so a step the engine re-runs after an interruption goes
to review instead of publishing twice; platform outcomes are returned, not
thrown, with engine retries off for that step; every transition and its audit
row are one batch guarded by the lease. A publish that outlives its 300 s lease
is still recorded as posted. Verified locally end to end with a fake Telegram
token (404 → `failed`, audit rows, no retry), plus media attach/shared
references/sweep. Not verified: a real publish to any platform (needs real
accounts); the failure emails (item 5, Mailgun); recurring next-occurrence
creation (item 9). Posts to platforms with no adapter still end in
`review_required`.

### Work item 9 — recurring posts and the reschedule gap (2026-11-16)

Migration `0009_schedule_revision.sql` adds `posts.schedule_revision`, bumped by
PATCH whenever the time or status changes. The revision is part of the
Workflow instance id (`post-<id>-<scheduledFor>-<revision>`), the instance
params, `recordWorkflowInstance` and the claim, closing the gap noted under
item 7: an older instance can no longer publish, or be reused for, a later
schedule, even when a post returns to a previous time. Verified locally: a
reschedule moved a post from `…-0` to `…-1`. Workflow definition is now `-v8`
(`-v7` deleted).

`src/lib/recurrence.ts` `scheduleNextOccurrence()` runs as its own idempotent
Workflow step after a post is **published** (a failed or review post stops the
series, as in Docker). It copies the post (content, platform options, group,
repeat settings, `repeat_parent_id` = series root) with `scheduled_for` = the
next interval and re-points the same media objects (no byte copies). Differences
from Docker, deliberately: occurrences already in the past are skipped instead
of published back to back after downtime (missed-schedule policy), intervals are
UTC, and monthly clamps to the month's last day (Jan 31 → Feb 28; it does not
snap back to the 31st afterwards). `repeat_until` and the one-year cap stop the
series; a duplicate call creates nothing. Verified with a SQLite shim of D1 over
all migrations: next occurrence, idempotence, media re-pointing, late-skip,
`repeat_until`, cap, non-recurring, month clamp. The end-to-end path (publish →
next occurrence) still needs a real publish to exercise.

### Work item 12 — webhooks (2026-11-16)

Migration `0010_webhook_deliveries.sql`. `/api/v1/webhooks` (GET, POST, DELETE,
`GET /:id/deliveries` = last 50 attempts): https URLs only, no IP literals,
localhost, single-label or internal suffixes, no credentials in the URL; at
most 10 endpoints; the signing secret (`whsec_…`, HMAC-SHA-256 as
`X-Postfalcon-Signature: sha256=…`) is returned once, at creation. Events:
`post.published`, `post.failed` (the Docker app's two, the default) plus
`post.review_required`, an addition so an ambiguous publish is not silent.
Delivery is a durable Workflow step per endpoint after the outcome is recorded
(`-v9`, 60-step cap): `X-Postfalcon-Delivery` is the stable instance+event key,
8 s timeout, no redirects, up to 3 retries with exponential backoff for network
errors, 5xx and 429 only (other 4xx are final); every attempt is stored and
pruned after 30 days. Secrets are read inside the step, never kept in Workflow
state, and a webhook failure never changes the post. Verified with a SQLite/fetch
harness (signature, history, deleted endpoint, URL rules) and the CRUD routes
locally. Not exercised: a real endpoint receiving a delivery from the Worker.

### Work item 13 — MCP (2026-11-16)

`POST /mcp` (Streamable HTTP, stateless, JSON responses) using the SDK's
web-standard transport, which runs on Workers. **Bearer token only**: a session
cookie is refused because the endpoint is open-origin, so cookie auth would let
another site trigger tool calls; the token is verified before any tool runs.
`src/lib/mcp.ts` registers `list_accounts`, `list_posts`, `create_post`,
`update_post`, `delete_post`; each dispatches **in-process** into this Worker's
own `/api/v1` routes with the caller's token (no network subrequest, and the
tools can never exceed what the token can do over REST). `get_analytics_summary`
is deferred with item 11. Verified locally: 401 for no/cookie/bad token, 405 for
GET, initialize, tools/list, list_accounts, create_post. Not verified: a real
MCP client (Claude Code/Cursor) against staging.

### Work item 11 — metrics and analytics (2026-11-16)

`fetchMetrics` on the Mastodon and Bluesky adapters (Bluesky reads the public
AppView, no login). `src/lib/metrics.ts` `refreshPostMetrics()` runs every 3
hours at :30 from the Cron Trigger: the 20 posts with the oldest numbers among
posts published in the last 30 days, so a large backlog rotates instead of
exceeding the Free plan's 50 subrequests per invocation; a post the platform no
longer has is stamped so it cannot starve the queue; a 401 flags the account for
reconnecting. The delivery workflow (`-v10`) also reads metrics once right
after a publish. `GET /api/v1/analytics/summary?days=7|30|90&tz=` returns the
Docker app's shape (per-day series bucketed on the viewer's IANA timezone,
period figures, platform breakdown, top posts, all-time totals, top post of the
week; a metric is null when no post reports it), aggregated in the Worker. The
`get_analytics_summary` MCP tool is back. Verified locally: a real public
Bluesky post's counts were fetched and stored, and the summary aggregated
Bluesky + Telegram rows with a Sydney timezone; unknown timezone falls back to
UTC; 401 unauthenticated. Facebook/Instagram/Threads/YouTube metrics come with
their adapters.

### Work item 10 — admin operations, credential-free part (2026-11-16)

`/api/admin/*` (404 to non-admins, like the Docker admin console):
`GET /overview` — a `problems` list (scheduler silent >5 min or failed, overdue
scheduled posts, posts mid-publish, posts in review, accounts needing
reconnect, R2 use ≥80% of any hard cap, no owner yet) plus scheduler last run,
post counts, R2 use against each cap with percentages, applied D1 migrations
and the adapters that can publish; `GET /review` — posts awaiting manual
review with the reason; `POST /posts/:id/resolve` with `retry` (publish again,
new schedule revision), `mark_posted` (optionally with the platform id; also
queues the next recurrence) or `mark_failed`. Verified locally with seeded
review posts. Not done: weekly R2 export of D1 and restore (needs a
least-privilege API token and your decision on where exports live — D1 Time
Travel's 7-day restore is the only backup until then), a version/commit
display, platform on/off switches (every platform without a connect flow here
is already off), admin customer management (single owner), and the email
alerts, which wait on Mailgun.

### Work item 5 — Mailgun email (2026-11-16)

`src/lib/mailer.ts`: Mailgun's HTTP API (US or EU host), one attempt per call,
every send recorded in `email_deliveries` (recipient, category, status, Mailgun
id; never the body). Not configured → nothing is sent and callers are told so.
Configuration is four **undeclared** secrets (`MAILGUN_API_KEY`, `_DOMAIN`,
`_FROM`, `_REGION`), set with `cf workers secrets update`: declared secrets are
required at deploy time, so declaring them would force fake values; verified on
staging that an undeclared secret survives a redeploy. Emails: password reset
(`/auth/forgot-password` always answers 204 and does its work after the response
so neither status nor timing reveals whether an address exists; one live token
per purpose, 1 h, single use, resets sign out every session) and verification
(`/auth/verify-email`, `/auth/resend-verification`); and, from the delivery
Workflow (`-v11`), alerts to the admins when a post lands in `review_required`
and, once per account, when a publish proves the credential is dead. Alerts are
a retried step (2 retries); a failure there never changes the post.
`POST /api/admin/test-email` proves the settings. Verified: sender against a
stubbed Mailgun (hosts, auth, success/401/network, no body stored); reset,
reuse, expiry-free paths, sign-out of old sessions, verification locally.
**Not verified against real Mailgun** (no key). The reset link points at
`/reset-password`, which has no page until the UI port.

**budget_hold (2026-11-16, workflow `-v12`).** Per the plan's R2 cap rule, when
a publish needs media and the Class B read budget is spent, the adapter error is
`budget` (nothing was posted) and the post goes to `budget_hold` instead of
failing; text-only posts keep flowing. The 15-minute maintenance pass
(`resumeBudgetHolds`) returns held posts to `scheduled` (new schedule revision,
so a fresh Workflow instance) once the month's counter has room — in practice
after the UTC month rolls over. The admin overview lists held posts as a
problem. Verified with a SQLite shim: held while exhausted, released in a new
month.

### Browser UI port, first slice (2026-11-16)

The Docker app's own UI is reused, not rewritten: `cloudflare/scripts/build-ui.mjs`
precompiles every `../views/*.ejs` to plain functions (`src/views/generated.ts`,
git-ignored; EJS uses `new Function`, forbidden on Workers) and copies `../public`
plus FullCalendar into `cloudflare/public/` (git-ignored; `overrides/public/*`
replaces same-named files). Because ES modules are strict, templates are compiled
without `with (locals)` and each template's free identifiers are declared from
`locals` (`withoutWith`). `src/lib/views.ts` renders them; `src/routes/pages.ts`
serves `/login`, `/forgot-password`, `/reset-password`, `/dashboard`, `/analytics`,
`/accounts`, `/settings`, `/robots.txt` and an HTML 404; `/api/onboarding` backs the
dashboard checklist. These paths are `runWorkerFirst`; other files are static assets.
`typecheck` and `build` run `build:ui` first. Verified locally with `cf dev`: the
auth pages and static files serve, `/dashboard` redirects when signed out.

**First-run owner page (done).** `/setup` and `/signup` render the Docker sign-up view
only while no account exists (else redirect to `/login`); `overrides/public/signup.js`
adds a Setup token field and posts to `/api/setup`, which creates the owner and
signs them in. Verified locally with `cf dev`: setup returns 201, then `/dashboard`,
`/accounts`, `/settings`, `/analytics` render (200) for that session and
`/api/onboarding`, `/api/v1/social-accounts`, `/api/v1/posts` answer.

**Next:** drive the signed-in pages in a real browser (composer, calendar,
media upload, connect forms) to catch API-shape gaps; the composer's
`/api/v1/media` and `/api/v1/posts` calls are untested through the front end.
Not yet deployed to staging.

### Staging walkthrough fixes (2026-11-16)

First browser pass on staging (owner signed in): pages, accounts, settings, analytics
and sign-out all worked; two bugs. (1) The composer posts `multipart/form-data`
(text fields, JSON-string option fields, `media` files) but `POST /api/v1/posts`
only read JSON, so draft/post/schedule all failed validation. It now also accepts
multipart: files are stored through the shared `storeImage()` (extracted from the
media route, same R2 caps) and the request continues with `media_ids`. A request
that fails validation after upload leaves its image unreferenced in R2; nothing
sweeps those yet. (2) Settings showed `not_found` because `/api/billing/status`
didn't exist; it now answers `{billingConfigured:false}`. Verified locally with
curl (draft, scheduled post with image and alt text) and redeployed staging.
Still to confirm in the browser: composer, scheduling, calendar drag, media preview.

**CSP fix (2026-11-16).** The Worker's policy said `style-src 'self'`, stricter than the
Docker app (helmet's default also allows `'unsafe-inline'` and https styles). FullCalendar
couldn't inject its styles, so calendar events couldn't be dragged. Policy now matches
Docker's. Telegram publishing was confirmed working on staging (a 403 was the account's
chat id being the bot itself).
