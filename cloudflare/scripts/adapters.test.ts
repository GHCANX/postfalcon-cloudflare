// Stubbed-fetch checks for the platform publish adapters. Run:
//   npx esbuild scripts/adapters.test.ts --bundle --platform=node --format=esm \
//     --outfile=/tmp/adapters.test.mjs && node /tmp/adapters.test.mjs
// Adapters call the global fetch, so the stub below records every request.
import { facebook } from "../src/platforms/facebook";
import { linkedin } from "../src/platforms/linkedin";
import { pinterest } from "../src/platforms/pinterest";
import { threads } from "../src/platforms/threads";
import { tiktok } from "../src/platforms/tiktok";
import { youtube } from "../src/platforms/youtube";
import type { PublishMedia, PublishPost } from "../src/platforms/types";

const MIB = 1024 * 1024;

type Recorded = { url: string; method: string; headers: Record<string, string>; body: unknown };
let requests: Recorded[] = [];
let rangeReads: { offset: number; length: number }[] = [];
let wholeReads = 0;
// Per-test route table for the platforms added after TikTok; returns null for an unknown URL.
let handler: ((url: string, init: RequestInit) => Response | null) | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  requests.push({ url, method: init?.method ?? "GET", headers, body: init?.body ?? null });

  if (url.includes("creator_info/query")) {
    return jsonResponse({ data: { privacy_level_options: ["SELF_ONLY"] }, error: { code: "ok" } });
  }
  if (url.includes("video/init/")) {
    return jsonResponse({ data: { publish_id: "pub-test-1", upload_url: "https://upload.tiktok.example/put" }, error: { code: "ok" } });
  }
  if (url === "https://upload.tiktok.example/put") {
    return new Response(null, { status: 200 });
  }
  if (url.includes("status/fetch/")) {
    return jsonResponse({ data: { status: "PUBLISH_COMPLETE" }, error: { code: "ok" } });
  }
  const extra = handler?.(url, init ?? {});
  if (extra) return extra;
  throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
}) as typeof fetch;

function makeMedia(size: number, contentType = "video/mp4"): PublishMedia & { readCalls: number } {
  const media = {
    path: "video.mp4",
    contentType,
    altText: null,
    size,
    readCalls: 0,
    async read() {
      media.readCalls += 1;
      wholeReads += 1;
      return new ArrayBuffer(size);
    },
    async readRange(offset: number, length: number) {
      rangeReads.push({ offset, length });
      return new ArrayBuffer(length);
    },
  };
  return media;
}

function makePost(media: PublishMedia[]): PublishPost {
  return {
    postId: 1,
    idempotencyKey: "test-key",
    content: "adapter test",
    accessToken: "token",
    refreshToken: null,
    // Far future: no refresh request is made.
    tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    saveTokens: async () => {},
    env: {} as Env,
    externalAccountId: null,
    metadata: {},
    platformOptions: {},
    media,
  };
}

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) console.log(`ok   ${name}`);
  else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function reset() {
  requests = [];
  rangeReads = [];
  wholeReads = 0;
}

// --- TikTok: 30 MiB video -> a single chunk via read() -----------------------
{
  reset();
  const size = 30 * MIB;
  const media = makeMedia(size);
  const id = await tiktok.publish(makePost([media]));
  const init = requests.find((r) => r.url.includes("video/init/"));
  const initBody = JSON.parse(String(init?.body));
  const puts = requests.filter((r) => r.url === "https://upload.tiktok.example/put");
  check("tiktok 30MiB returns publish id", id === "pub-test-1");
  check("tiktok 30MiB init chunk plan", initBody.source_info.chunk_size === size && initBody.source_info.total_chunk_count === 1,
    JSON.stringify(initBody.source_info));
  check("tiktok 30MiB one PUT via read()", puts.length === 1 && media.readCalls === 1 && rangeReads.length === 0,
    `puts=${puts.length} reads=${media.readCalls} ranges=${rangeReads.length}`);
  check("tiktok 30MiB content-range", puts[0]?.headers["content-range"] === `bytes 0-${size - 1}/${size}`, puts[0]?.headers["content-range"]);
}

// --- TikTok: 200 MiB video -> 16 MiB chunks via readRange --------------------
{
  reset();
  const size = 200 * MIB;
  const chunk = 16 * MIB;
  const media = makeMedia(size);
  const id = await tiktok.publish(makePost([media]));
  const init = requests.find((r) => r.url.includes("video/init/"));
  const initBody = JSON.parse(String(init?.body));
  const expectedCount = Math.floor(size / chunk); // 12
  const puts = requests.filter((r) => r.url === "https://upload.tiktok.example/put");
  check("tiktok 200MiB returns publish id", id === "pub-test-1");
  check("tiktok 200MiB init chunk plan",
    initBody.source_info.video_size === size &&
    initBody.source_info.chunk_size === chunk &&
    initBody.source_info.total_chunk_count === expectedCount,
    JSON.stringify(initBody.source_info));
  check("tiktok 200MiB PUT count", puts.length === expectedCount, `puts=${puts.length}`);
  check("tiktok 200MiB readRange count", rangeReads.length === expectedCount && media.readCalls === 0,
    `ranges=${rangeReads.length} wholeReads=${media.readCalls}`);

  let sequential = true;
  let lastEnd = -1;
  puts.forEach((put, index) => {
    const first = index * chunk;
    const last = index === expectedCount - 1 ? size - 1 : first + chunk - 1;
    const expectedRange = `bytes ${first}-${last}/${size}`;
    if (put.headers["content-range"] !== expectedRange) sequential = false;
    const read = rangeReads[index];
    if (!read || read.offset !== first || read.length !== last - first + 1) sequential = false;
    lastEnd = last;
  });
  check("tiktok 200MiB sequential Content-Range headers", sequential);
  check("tiktok 200MiB last chunk absorbs remainder", lastEnd === size - 1 && puts[expectedCount - 1]?.headers["content-range"]?.endsWith(`/${size}`));
  // The final chunk is larger than 16 MiB: 200 MiB - 11*16 MiB = 24 MiB.
  const lastRange = rangeReads[expectedCount - 1];
  check("tiktok 200MiB last range is the remainder", lastRange?.length === size - (expectedCount - 1) * chunk,
    `last=${lastRange?.length} expected=${size - (expectedCount - 1) * chunk}`);
}

// --- TikTok: exactly 64 MiB still goes as one chunk --------------------------
{
  reset();
  const size = 64 * MIB;
  const media = makeMedia(size);
  await tiktok.publish(makePost([media]));
  const init = requests.find((r) => r.url.includes("video/init/"));
  const initBody = JSON.parse(String(init?.body));
  const puts = requests.filter((r) => r.url === "https://upload.tiktok.example/put");
  check("tiktok 64MiB boundary is one chunk", initBody.source_info.total_chunk_count === 1 && puts.length === 1 && media.readCalls === 1);
}

// --- Facebook, Threads, LinkedIn, Pinterest, YouTube --------------------------
const NOW = () => Math.floor(Date.now() / 1000);
const body = (request: Recorded | undefined) => JSON.parse(String(request?.body ?? "{}")) as Record<string, any>;
const ENV = { PUBLIC_BASE_URL: "https://pf.example", GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret", PINTEREST_APP_ID: "pid", PINTEREST_APP_SECRET: "psecret" } as unknown as Env;
const jpeg = (path: string, size = 10): PublishMedia => ({ ...makeMedia(size, "image/jpeg"), path });
const base = (over: Partial<PublishPost>): PublishPost => ({ ...makePost([]), env: ENV, ...over });

// Facebook: text post, then photos (unpublished upload -> attached to the feed post), then metrics.
{
  reset();
  handler = (url) => (url.endsWith("/PAGE/feed") ? jsonResponse({ id: "PAGE_1" }) : url.endsWith("/PAGE/photos") ? jsonResponse({ id: "photo-1" }) : null);
  check("facebook text post id", (await facebook.publish(base({ externalAccountId: "PAGE" }))) === "PAGE_1");
  check("facebook text body", body(requests[0]).message === "adapter test" && body(requests[0]).access_token === "token");
  reset();
  await facebook.publish(base({ externalAccountId: "PAGE", media: [jpeg("a.jpg")] }));
  const upload = requests.find((r) => r.url.endsWith("/PAGE/photos"));
  const feed = requests.find((r) => r.url.endsWith("/PAGE/feed"));
  check("facebook photo uploaded unpublished", upload?.body instanceof FormData && (upload.body as FormData).get("published") === "false");
  check("facebook feed attaches photo", JSON.stringify(body(feed).attached_media) === JSON.stringify([{ media_fbid: "photo-1" }]));
  handler = () => jsonResponse({ likes: { summary: { total_count: 3 } }, comments: { summary: { total_count: 1 } } });
  reset();
  const target = { platformPostId: "PAGE_1", accessToken: "t", refreshToken: null, tokenExpiresAt: null, saveTokens: async () => {}, env: ENV, externalAccountId: "PAGE", metadata: {} };
  const metrics = await facebook.fetchMetrics!(target);
  check("facebook metrics (page post asks for shares)", metrics?.likes === 3 && metrics.comments === 1 && metrics.shares === 0 && requests[0]?.url.includes("shares"));
  reset();
  await facebook.fetchMetrics!({ ...target, platformPostId: "123" });
  check("facebook metrics (video id omits shares)", !decodeURIComponent(requests[0]!.url).includes(",shares"));
}

// Threads: container flow, token refresh near expiry, metrics shape.
{
  reset();
  handler = (url) =>
    url.includes("/threads_publish") ? jsonResponse({ id: "th-1" })
    : url.includes("/U1/threads") ? jsonResponse({ id: "c-1" })
    : url.includes("/c-1?") ? jsonResponse({ status: "FINISHED" })
    : url.includes("refresh_access_token") ? jsonResponse({ access_token: "new-token", expires_in: 5184000 })
    : null;
  const id = await threads.publish(base({ externalAccountId: "U1", tokenExpiresAt: NOW() + 30 * 86400 }));
  check("threads text post id", id === "th-1");
  check("threads no refresh with a month left", !requests.some((r) => r.url.includes("refresh_access_token")));
  check("threads TEXT container", body(requests[0]).media_type === "TEXT" && body(requests[0]).text === "adapter test");
  reset();
  let saved: [string, number | null] | null = null;
  await threads.publish(base({ externalAccountId: "U1", tokenExpiresAt: NOW() + 3 * 86400, saveTokens: async (access, _refresh, expires) => { saved = [access, expires]; } }));
  check("threads refreshes inside the 7-day margin and uses the new token", saved?.[0] === "new-token" && body(requests.find((r) => r.url.includes("/U1/threads")))!.access_token === "new-token");
  reset();
  await threads.publish(base({ externalAccountId: "U1", tokenExpiresAt: NOW() + 30 * 86400, media: [jpeg("p.jpg")] }));
  check("threads image container uses a public URL", body(requests[0]).image_url === "https://pf.example/uploads/p.jpg");
  handler = () => jsonResponse({ data: [{ name: "views", values: [{ value: 9 }] }, { name: "likes", total_value: { value: 2 } }, { name: "replies", values: [{ value: 1 }] }, { name: "reposts", values: [{ value: 0 }] }] });
  const metrics = await threads.fetchMetrics!({ platformPostId: "th-1", accessToken: "t", refreshToken: null, tokenExpiresAt: NOW() + 30 * 86400, saveTokens: async () => {}, env: ENV, externalAccountId: "U1", metadata: {} });
  check("threads metrics map both shapes", metrics?.views === 9 && metrics.likes === 2 && metrics.comments === 1 && metrics.shares === 0);
}

// LinkedIn: id from header, little-text escaping, media refused.
{
  reset();
  handler = (url) => (url === "https://api.linkedin.com/rest/posts" ? new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:7" } }) : null);
  const id = await linkedin.publish(base({ externalAccountId: "abc", content: "Hi (you) #tag @me" }));
  check("linkedin id from x-restli-id", id === "urn:li:share:7");
  check("linkedin escapes markup but keeps hashtags", body(requests[0]).commentary === "Hi \\(you\\) #tag \\@me", JSON.stringify(body(requests[0]).commentary));
  check("linkedin author urn", body(requests[0]).author === "urn:li:person:abc");
  let refused = "";
  await linkedin.publish(base({ externalAccountId: "abc", media: [jpeg("a.jpg")] })).catch((error: { kind?: string }) => { refused = error.kind ?? ""; });
  check("linkedin media is rejected, not retried", refused === "rejected");
}

// Pinterest: a refused board falls through to another and the account remembers it.
{
  reset();
  const pins: string[] = [];
  handler = (url, init) => {
    if (url.endsWith("/v5/pins")) {
      const board = JSON.parse(String(init.body)).board_id as string;
      pins.push(board);
      return board === "old" ? jsonResponse({ code: 400, message: "Board not found" }, 400) : jsonResponse({ id: "pin-1" });
    }
    if (url.includes("/v5/boards")) return jsonResponse({ items: [{ id: "old", name: "Old" }, { id: "good", name: "Good" }] });
    return null;
  };
  let metadata: Record<string, any> | null = null;
  const id = await pinterest.publish(base({ metadata: { board_id: "old" }, media: [jpeg("pin.jpg")], saveMetadata: async (next) => { metadata = next; } }));
  check("pinterest falls through to a working board", id === "pin-1" && pins.join() === "old,good", pins.join());
  check("pinterest remembers the board and the refusal", metadata?.board_id === "good" && JSON.stringify(metadata?.unusable_board_ids) === JSON.stringify(["old"]), JSON.stringify(metadata));
  check("pinterest pin uses the public image URL", requests.some((r) => r.url.endsWith("/v5/pins") && body(r).media_source.url === "https://pf.example/uploads/pin.jpg"));
  let kind = "";
  await pinterest.publish(base({ metadata: { board_id: "good" } })).catch((error: { kind?: string }) => { kind = error.kind ?? ""; });
  check("pinterest needs an image", kind === "rejected");
  // An expired token refreshes with Basic auth.
  reset();
  handler = (url) => (url.endsWith("/v5/oauth/token") ? jsonResponse({ access_token: "p2", refresh_token: "r2", expires_in: 3600 }) : url.endsWith("/v5/pins") ? jsonResponse({ id: "pin-2" }) : null);
  await pinterest.publish(base({ metadata: { board_id: "good" }, media: [jpeg("pin.jpg")], refreshToken: "r1", tokenExpiresAt: NOW() - 10 }));
  check("pinterest refresh uses Basic auth", requests[0]?.headers.authorization === `Basic ${btoa("pid:psecret")}`);
}

// YouTube: refresh, resumable init, 8 MiB chunks (308, 308, then 200).
{
  reset();
  const ranges: string[] = [];
  handler = (url, init) => {
    if (url === "https://oauth2.googleapis.com/token") return jsonResponse({ access_token: "g2", expires_in: 3600 });
    if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos")) return new Response(null, { status: 200, headers: { location: "https://upload.youtube.example/session" } });
    if (url === "https://upload.youtube.example/session") {
      const range = new Headers(init.headers).get("content-range")!;
      ranges.push(range);
      const end = Number(range.split("-")[1]!.split("/")[0]);
      const total = Number(range.split("/")[1]);
      return end === total - 1 ? jsonResponse({ id: "yt-1" }) : new Response(null, { status: 308, headers: { range: `bytes=0-${end}` } });
    }
    return null;
  };
  const size = 20 * MIB;
  const media = makeMedia(size);
  let saved = "";
  const id = await youtube.publish(base({ media: [media], refreshToken: "rt", tokenExpiresAt: NOW() - 5, platformOptions: { title: "My <video>", privacy_status: "unlisted", made_for_kids: false }, saveTokens: async (access) => { saved = access; } }));
  const init = body(requests.find((r) => r.url.startsWith("https://www.googleapis.com/upload")));
  check("youtube returns video id", id === "yt-1");
  check("youtube refreshed the expired token", saved === "g2" && requests.find((r) => r.url.startsWith("https://www.googleapis.com/upload"))?.headers.authorization === "Bearer g2");
  check("youtube metadata from options", init.snippet.title === "My video" && init.status.privacyStatus === "unlisted" && init.status.selfDeclaredMadeForKids === false, JSON.stringify(init));
  check("youtube three sequential chunks via readRange", ranges.join() === [`bytes 0-${8 * MIB - 1}/${size}`, `bytes ${8 * MIB}-${16 * MIB - 1}/${size}`, `bytes ${16 * MIB}-${size - 1}/${size}`].join() && rangeReads.length === 3 && media.readCalls === 0, ranges.join());
  reset();
  await youtube.publish(base({ media: [makeMedia(1 * MIB)] }));
  check("youtube default visibility is private", body(requests.find((r) => r.url.startsWith("https://www.googleapis.com/upload"))).status.privacyStatus === "private");
  handler = () => jsonResponse({ items: [{ statistics: { viewCount: "100", likeCount: "7", commentCount: "2" } }] });
  const metrics = await youtube.fetchMetrics!({ platformPostId: "yt-1", accessToken: "t", refreshToken: null, tokenExpiresAt: NOW() + 3600, saveTokens: async () => {}, env: ENV, externalAccountId: null, metadata: {} });
  check("youtube metrics", metrics?.views === 100 && metrics.likes === 7 && metrics.comments === 2 && metrics.shares === null);
}
handler = null;

globalThis.fetch = realFetch;
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
