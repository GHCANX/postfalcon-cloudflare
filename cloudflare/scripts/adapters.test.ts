// Stubbed-fetch checks for the platform publish adapters. Run:
//   npx esbuild scripts/adapters.test.ts --bundle --platform=node --format=esm \
//     --outfile=/tmp/adapters.test.mjs && node /tmp/adapters.test.mjs
// Adapters call the global fetch, so the stub below records every request.
import { tiktok } from "../src/platforms/tiktok";
import type { PublishMedia, PublishPost } from "../src/platforms/types";

const MIB = 1024 * 1024;

type Recorded = { url: string; method: string; headers: Record<string, string>; body: unknown };
let requests: Recorded[] = [];
let rangeReads: { offset: number; length: number }[] = [];
let wholeReads = 0;

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

globalThis.fetch = realFetch;
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
