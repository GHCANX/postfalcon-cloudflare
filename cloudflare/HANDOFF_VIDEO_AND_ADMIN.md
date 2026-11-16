# Handoff: 300 MB video uploads, then the admin pages

Written 2026-11-16 for the next agent. Read `/CLOUDFLARE_PLAN.md` ("Implementation
progress", last sections) and `/CLAUDE.md` ("Cloudflare free-tier port") first; they hold the
rules this plan assumes. Work the two parts in order and append a dated note to
`CLOUDFLARE_PLAN.md` after each step.

## Ground rules (from the project owner)

- Zero cost: no Workers Paid, no Containers. R2 use stays hard-capped in code (fails closed).
- A publish that ends ambiguously is never retried automatically (`review_required` + email).
- Prefix commands with `PATH=$HOME/.nvm/versions/node/v24.17.0/bin:$PATH` (Node 24).
  `npm run typecheck` and `npm run build` are safe. `cf deploy`, `cf d1 migrations apply`
  and secret changes touch the live Cloudflare account: say what you will run, and only
  deploy when the user asks. Never pkill `cf dev` by name (it kills your own shell); start
  it with `timeout 90 npx cf dev --mode development &` and let it end.
- Staging: https://postfalcon-staging.rowenparedes.workers.dev (Worker `postfalcon-staging`).
  No production resources exist. The user signs in through the built-in browser pane and
  tests there; do not drive their signed-in session unless they say so.
- Commit and push to `origin main` (GHCANX/postfalcon-cloudflare). Commit trailer:
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Do not touch the Docker app.
- Workflow definitions keep running the code they were created with: any change to code the
  delivery Workflow bundles (adapters, `lib/publish.ts`) needs the `-vN` suffix bumped in
  `cloudflare.config.ts` (currently `-v13`; bump to `-v14` when Part A deploys).

---

## Part A: allow videos up to 300 MB

### Why it is more than a config change

Cloudflare's Free plan caps one request body at 100 MB, and a Worker has about 128 MB of
memory. So a 300 MB file must be uploaded in parts (R2 multipart) and read back in ranges.
The Docker UI sends one multipart form, so the browser needs a small shim too.

### State at handoff (committed in the commit titled "WIP: chunked uploads")

Done, typechecks, **not exercised yet**:

| Piece | Where |
| --- | --- |
| Budget fields: `maxObjectBytes` = 300 MiB (chunked ceiling), new `maxDirectUploadBytes` = 25 MiB (single request: images and small videos) | `cloudflare.config.ts`, `src/lib/r2-budget.ts`, `src/lib/r2-media.ts` |
| Migration `0011_media_uploads.sql` (table `media_uploads`); validated against sqlite only | `migrations/` |
| Chunked API under `/api/v1/media`: `POST /uploads` `{content_type,size}` -> `{id,part_size,part_count}`; `PUT /uploads/:id/parts/:n` (raw body, exact Content-Length); `POST /uploads/:id/complete` -> `{id,url,...}`; `DELETE /uploads/:id` | `src/routes/media.ts` |
| Part size 32 MiB, `abortUpload()`, `sweepStaleUploads()` (24 h, called from `runMaintenance` in `src/index.ts`) | `src/lib/media.ts` |
| Reservation: whole declared size reserved at create (media + total bytes, 1 Class A op); 1 Class A per part and for complete; released on abort | `src/routes/media.ts` |
| Multipart post form accepts repeated `media_ids` | `src/routes/posts.ts` |
| Publish side: `PublishMedia.size` and `readRange()`; `read()` refuses files over 64 MiB; Telegram rejects over 50 MB; TikTok uploads over 64 MiB in 16 MiB range-read chunks | `src/lib/publish.ts`, `src/platforms/{types,telegram,tiktok}.ts` |

### Remaining steps

1. **Review the diff** (`git show --stat HEAD`) and re-read `src/routes/media.ts` once.
   Check: a part is rejected unless Content-Length equals the expected size; `complete`
   verifies the assembled size; only the owner can touch an upload (queries filter on
   `user_id`).
2. **Browser shim.** `scripts/build-ui.mjs` copies `../public` to `cloudflare/public/` and
   overlays `overrides/public/*`. Add an overlay mechanism that *appends* to a copied file
   (e.g. `overrides/append/common.js`, concatenated onto `public/common.js` after the copy).
   The appended code redefines the global `apiUpload(path, formData, onProgress)`
   (`../public/common.js` line ~82; the composer calls it for posts with files):
   - Leave it alone unless `path === '/api/v1/posts'` and the total size of
     `formData.getAll('media')` exceeds ~24 MiB.
   - Otherwise, for each media `File` in order: `POST /api/v1/media/uploads`, then `PUT` each
     32 MiB slice (`file.slice`) to `/parts/:n` with XHR (progress), then `POST .../complete`.
     Send header `x-csrf-token` from `getCsrfToken()` on every call. On any failure, `DELETE`
     the upload and reject with a readable message.
   - Then `formData.delete('media')`, append one `media_ids` per returned id (order = position;
     `alt_texts` stays aligned), and call the original `apiUpload` with the small form.
   - Report aggregate progress through `onProgress`.
3. **Local test** (`npm run dev`, owner `o@example.com` / `password123` in the local D1; a
   Telegram test account row exists with id 1). Apply the migration locally first
   (`cf d1 migrations apply ... --local` or restart; check how earlier migrations were
   applied locally). Use `curl` to drive the API with a ~70 MB random file: create, PUT parts
   with `--data-binary @part`, complete, then create a post with `media_ids` and range-read
   the file (expect 206). Also test: wrong Content-Length (400), abort releases
   `r2_budget_state.media_bytes`, an image over 25 MiB is refused at create (413), a video
   over 300 MiB is refused (413), and `sweepStaleUploads` aborts an old row.
4. **Update the adapter test script** (`/tmp/.../adapters.test.ts` is gone; recreate): the
   fixtures need `size` and `readRange` on each media item. Add TikTok cases: 200 MiB video
   -> `total_chunk_count = floor(size/16 MiB)`, `Content-Range` headers sequential and the
   last chunk absorbs the remainder; 30 MiB video -> one chunk via `read()`.
5. **Docs.** `README.md`: per-file limits (images 25 MiB, video 300 MiB, chunked), the 7 GiB
   media / 8 GiB total caps still apply (about 23 maximum-size videos), Class A cost per
   upload (parts + 2). `CLOUDFLARE_PLAN.md`: dated note; mention `admin overview` shows
   `objectMiB` from `maxObjectBytes` (`src/routes/admin.ts` line ~87) so it now reads 300.
6. **Deploy to staging only when the user says so**, in this order: bump workflow to `-v14`,
   `npm run d1:migrate:staging` (the maintenance sweep queries `media_uploads`, so the
   migration must land first), then `npm run deploy:staging`. Then have the user upload a
   ~100 MB MP4 in the composer and confirm: progress shows, draft saves, preview plays and
   seeks, and a Telegram post of a >50 MB file fails with the clear message.

Acceptance: a 300 MB MP4 saves to a draft from the browser; abandoned uploads are aborted
and their reserved bytes returned; R2 caps in `R2_BUDGET` are unchanged except the two
object limits above; nothing in the Docker app changed.

Known limits to leave as is (document, don't fix): Bluesky
rejects video; Instagram video is Part A2 below, not part of this step; Mastodon (whole-file `read()`) fails over 64 MiB with the "too large" message;
TikTok is the only platform that streams large files.

### Part A2: Instagram video (Reels)

Do this after Part A is deployed and verified. Today `src/platforms/instagram.ts` rejects
anything that is not a JPEG; that is a gap in this port, not an Instagram limit. The Docker
adapter (`../lib/platforms/instagram.js`) sends `video_url` without `media_type=REELS`;
do not copy that without checking it still works.

1. **Read Meta's current docs first** (Instagram Platform > Content Publishing): confirm that
   a single video must be created with `media_type=REELS` + `video_url`, whether feed
   `VIDEO` is still accepted, and the current limits (codec, duration, aspect ratio, file
   size, container status codes). Put the confirmed limits in the adapter as named constants
   with a comment citing the doc, and in the README. Do not rely on memory.
2. **Accept video types.** Allow `video/mp4` and `video/quicktime` alongside `image/jpeg`;
   keep rejecting PNG/WebP/GIF with the existing message. Reject a mixed set that Instagram
   does not allow in one post (check the docs: carousels may mix photo and video, a Reel is
   a single video).
3. **Create the container.** Single video: `{ media_type: "REELS", video_url, caption }`
   (alt text does not apply to video). Carousel: video children use `media_type: "VIDEO"`,
   `is_carousel_item: true`, `video_url`. Public URL stays `<PUBLIC_BASE_URL>/uploads/<name>`;
   the object must be readable by Instagram's fetcher (range requests already work, and each
   fetch spends a Class B read from the monthly budget).
4. **Longer polling.** `waitForContainer` currently allows 15 x 2 s. Videos can take
   minutes: poll up to about 5 minutes with a growing interval (for example 3 s rising to
   15 s). Wall-clock time is fine inside a Workflow step; stay under the step's limits and
   keep every poll a retry-safe read. `ERROR`/`EXPIRED` map to `rejected` with Instagram's
   `status` text if present; running out of time maps to `transient` (nothing was published
   yet), never `ambiguous`.
5. **Keep the ambiguity rule.** Only `media_publish` is the final create; a lost response
   there is `ambiguous` as today.
6. **Tests.** Extend the stubbed-fetch script: single Reel (checks `media_type=REELS`,
   `video_url`, no `alt_text`), carousel with a video child, slow processing then
   `FINISHED`, `ERROR` status -> `rejected`, poll timeout -> `transient`, PNG still
   rejected.
7. **Cost note for the README.** Instagram fetches the whole video from R2: one Class B read
   per range request, and bandwidth is free from R2 but count the reads in the budget.
8. **Bump the Workflow suffix**, deploy only when the user asks, and note in the plan that it
   is **unverified against Meta** until a real app and Instagram business account exist.

---

## Part B: admin pages

### Inventory

Docker pages (views + `public/admin-*.js`, API in `routes/admin.js`) versus the Worker:

| Docker page | Calls | Worker today | Decision for the single-owner build |
| --- | --- | --- | --- |
| `/admin/overview` | `/api/admin/overview`, `/backups`, `/alerts`, `/alerts/check`, `/email/test`, `/version`, `/failed-posts`(+`/retry`) | JSON only: `GET /api/admin/overview`, `POST /api/admin/test-email`, `GET /api/admin/review`, `POST /api/admin/posts/:id/resolve` (`src/routes/admin.ts`). **No page.** | Port. Do first. |
| `/admin/platforms` | `/api/admin/platforms` (+`/:id`) | None | Port: on/off per platform + "how to set up". |
| `/admin/activity` | `/api/admin/errors`, `/failed-posts` | None | Port a reduced version (failed/review posts, server errors). |
| `/admin/settings` | `/api/admin/settings`, `/settings/logo`, `/signups` | None | Port only site name and alert emails; drop sign-up mode and logo. |
| `/admin/customers` | `/api/admin/users*`, invites, billing | None | **Skip**: one owner, no billing. Remove the sidebar link. |

None of the `/admin/*` pages are routed in `src/routes/pages.ts` yet, and none are in
`runWorkerFirst` in `cloudflare.config.ts`. The sidebar partial already shows the admin
section when `isAdmin` is true.

Important: the Docker front-end scripts expect Docker's JSON shapes. Before porting each
page, read its `public/admin-*.js` and the matching `routes/admin.js` handler, list the
fields it reads, and make the Worker endpoint return those names (adding an adapter in
`src/routes/admin.ts` is fine; do not edit `../public/*` or `../views/*`, use the
`overrides/` mechanism if a page needs changes). The Worker's `GET /overview` already has a
different, richer shape (scheduler heartbeat, R2 usage, review counts): verify against
`admin-overview.js` rather than assuming either side matches.

### Step 1: Email (Mailgun) section of the overview page

Mailgun sending, reset/verification/alert emails and `email_deliveries` already exist
(`src/lib/mailer.ts`, plan "Work item 5"). What is missing is the admin UI around it.

1. Add the page routes: `GET /admin` -> redirect `/admin/overview`; `GET /admin/overview`
   rendering the `admin-overview` view via `appPage(...)` in `src/routes/pages.ts` with an
   admin guard (`user.isAdmin`, else redirect `/dashboard`; copy the pattern of the other
   `appPage` routes). Add `/admin`, `/admin/*` to `runWorkerFirst`.
2. Serve what `admin-overview.js` needs. For the Email block specifically:
   - `POST /api/admin/email/test` -> same behavior as the existing
     `POST /api/admin/test-email` (keep both; alias the old path).
   - Extend the overview payload with an `email` object the page reads: `configured`
     (`mailConfigured(env)`), the sending domain and region (never the key), and the last
     few rows of `email_deliveries` (recipient, category, status, time; never bodies).
   - When not configured, the page should show the three `cf workers secrets update`
     commands (README "Email (Mailgun)") instead of a form: Workers secrets cannot be set
     from inside the app, so there is no "save key" box. Do not add one.
3. Overview sections that depend on missing pieces should degrade, not error: return empty
   arrays or `null` and let the page hide the block (backups, alerts, version, billing).
4. Verify locally with curl and by loading the page against `cf dev` (render check, console
   free of CSP errors), then ask the user to open `/admin/overview` on staging and press
   "Send test email" once Mailgun secrets are set (they have not been set on staging yet).

### Step 2: the rest of the overview page

Port the blocks in this order, each its own commit: (a) setup warnings and scheduler/post
counts (data already in `GET /overview`); (b) failed/review posts with bulk retry
(`/failed-posts`, `/failed-posts/retry`: map to the existing `review` + `resolve` logic and
the failed-post retry in `routes/posts.ts`); (c) Version (`src/lib` has none: report the
deployed Version ID if available, otherwise omit; skip the GitHub comparison unless trivial);
(d) Backups: the Docker pg_dump list does not apply. Replace with a short, honest block:
"D1 Time Travel restore window" and, if implemented later, R2 export. Do not fake it.
(e) Alerts (`/alerts`, `/alerts/check`): port `lib/alerts.js` semantics on D1 with a new
migration (`admin_alerts`), emailing the owner through `sendMail` once on start, daily while
active, once on resolve; run the check from `runMaintenance`.

### Step 3: Platforms page

New migration `0012_platform_settings.sql` (`platform_id` PK, `enabled`, `updated_at`) and a
small `src/lib/platform-settings.ts`. Registry of Worker platforms (id, label, color,
secrets required, redirect path) in one file, reused by `pages.ts` (replace the hardcoded
`PLATFORMS_ON_ACCOUNTS_PAGE`/Tiktok entry logic) and by `GET/PATCH /api/admin/platforms`.
"Offered" = switched on AND its secrets present (same rule as the Docker
`isPlatformOffered`). Off must also: 404 that platform's connect routes (`oauth.ts`,
`connect.ts`) and make the Workflow fail its due posts with a clear message instead of
publishing. Add a "How to set up" payload per platform from `PLATFORM_SETUP` in
`../lib/platforms.js` (console URL, callback paths, secret names, caveats), rewritten for
`cf workers secrets update` instead of `.env`.

### Step 4: Activity page

New migration for `server_errors` (rate-capped, 30-day prune like `lib/errorLog.js`) written
from `app.onError` and the Workflow's failure path; `GET /api/admin/errors`; port the
failed-posts list. Skip the Billing tab.

### Step 5: Settings page and cleanup

Only site name and alert-email toggle (an `instance_settings` row). Drop sign-up mode, logo
upload and invites (single owner; `/api/users` already returns 403). Remove the Customers
sidebar link via an overlay of `partials/sidebar` or a `res.locals`-style flag the view
already honors; if the view has no switch, add a `singleOwner` local to the build step's
render and wrap the link in the EJS in the *Docker* view only if that is a harmless,
default-off change (otherwise note it in the plan and leave the link).

### Definition of done for Part B

- `/admin/overview`, `/admin/platforms`, `/admin/activity`, `/admin/settings` render for the
  signed-in owner, redirect others, and show no console errors.
- The Email block reports Mailgun status, sends a test email, and lists recent deliveries.
- Platform switches change what Accounts offers and what the Workflow publishes.
- Each step has a plan note, a commit, and (when the user asks) a staging deploy plus a
  checklist like the one used for the composer (what to click, what to report back).
