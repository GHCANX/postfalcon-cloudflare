import { type PlatformAdapter, failPreStep, finalCreateFetch, PublishError, preStepFetch, readFetch } from "./types";

const PDS = "https://bsky.social";
const MAX_IMAGES = 4;
const encoder = new TextEncoder();

// Bluesky only linkifies text that carries "facets" (UTF-8 byte ranges): full
// http(s) URLs, bare domains on a short TLD list, and #hashtags. @mentions are
// left plain; linking them needs a handle lookup per mention.
const BARE_DOMAIN_TLDS = new Set(["com", "co", "org", "net", "io", "dev", "app", "social", "ai", "me", "xyz", "sh", "au", "uk", "de", "eu"]);
const TRAILING_PUNCTUATION = /[.,;:!?'")\]]+$/;

type Facet = { index: { byteStart: number; byteEnd: number }; features: Record<string, string>[] };

export function detectFacets(text: string): Facet[] {
  const facets: Facet[] = [];
  const byteOffset = (index: number) => encoder.encode(text.slice(0, index)).byteLength;
  const add = (start: number, end: number, feature: Record<string, string>) =>
    facets.push({ index: { byteStart: byteOffset(start), byteEnd: byteOffset(end) }, features: [feature] });

  for (const match of text.matchAll(/(^|[\s(])((https?:\/\/)?[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+(\/\S*)?)/gi)) {
    const raw = match[2]!.replace(TRAILING_PUNCTUATION, "");
    const hasScheme = Boolean(match[3]);
    const host = raw.replace(/^https?:\/\//i, "").split("/")[0]!;
    if (!hasScheme && !BARE_DOMAIN_TLDS.has(host.split(".").pop()!.toLowerCase())) continue;
    const start = match.index! + match[1]!.length;
    add(start, start + raw.length, { $type: "app.bsky.richtext.facet#link", uri: hasScheme ? raw : `https://${raw}` });
  }
  for (const match of text.matchAll(/(^|\s)#([^\s#]+)/gu)) {
    const tag = match[2]!.replace(/\p{P}+$/u, "");
    if (!tag || /^\d+$/.test(tag) || tag.length > 64) continue;
    const start = match.index! + match[1]!.length;
    add(start, start + 1 + tag.length, { $type: "app.bsky.richtext.facet#tag", tag });
  }
  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}

export const bluesky: PlatformAdapter = {
  async publish(post) {
    if (post.media.some((item) => item.contentType.startsWith("video/"))) {
      throw new PublishError("rejected", "Bluesky video posts aren't supported from this server yet; attach images instead.");
    }
    // Sessions are short-lived, so log in fresh for every publish with the
    // stored app password and the DID saved at connect time.
    const login = await preStepFetch(
      `${PDS}/xrpc/com.atproto.server.createSession`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: post.externalAccountId, password: post.accessToken }) },
      "Bluesky login",
    );
    if (login.status === 400 || login.status === 401) {
      throw new PublishError("auth", `Bluesky login failed (${login.status}): reconnect the account with a new app password`);
    }
    if (!login.ok) await failPreStep(login, "Bluesky login");
    const session = (await login.json().catch(() => ({}))) as { accessJwt?: string; did?: string };
    if (!session.accessJwt || !session.did) throw new PublishError("transient", "Bluesky login returned no session");
    const auth = { Authorization: `Bearer ${session.accessJwt}` };

    let embed: unknown;
    if (post.media.length > 0) {
      const images = [];
      for (const item of post.media.slice(0, MAX_IMAGES)) {
        const upload = await preStepFetch(
          `${PDS}/xrpc/com.atproto.repo.uploadBlob`,
          { method: "POST", headers: { ...auth, "Content-Type": item.contentType }, body: await item.read() },
          "Bluesky media upload",
        );
        if (!upload.ok) await failPreStep(upload, "Bluesky media upload");
        const data = (await upload.json().catch(() => ({}))) as { blob?: unknown };
        if (!data.blob) throw new PublishError("transient", "Bluesky media upload returned no blob");
        images.push({ image: data.blob, alt: item.altText ?? "" });
      }
      embed = { $type: "app.bsky.embed.images", images };
    }

    const facets = detectFacets(post.content);
    const record = {
      $type: "app.bsky.feed.post",
      text: post.content,
      createdAt: new Date().toISOString(),
      ...(facets.length ? { facets } : {}),
      ...(embed ? { embed } : {}),
    };
    const response = await finalCreateFetch(
      `${PDS}/xrpc/com.atproto.repo.createRecord`,
      { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ repo: session.did, collection: "app.bsky.feed.post", record }) },
      "Bluesky post",
    );
    const data = (await response.json().catch(() => ({}))) as { uri?: string };
    if (!data.uri) throw new PublishError("ambiguous", "Bluesky accepted the post but returned no uri");
    return data.uri;
  },

  // The public AppView serves engagement counts without a login. No "views" concept.
  async fetchMetrics(target) {
    const url = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts");
    url.searchParams.set("uris", target.platformPostId);
    const response = await readFetch(url.toString());
    if (!response.ok) throw new Error(`Bluesky post lookup failed (${response.status})`);
    const data = (await response.json().catch(() => ({}))) as { posts?: Record<string, any>[] };
    const found = data.posts?.[0];
    if (!found) return null;
    return { views: null, likes: found.likeCount ?? null, comments: found.replyCount ?? null, shares: found.repostCount ?? null };
  },
};
