import { type PlatformAdapter, type PublishFailureKind, PublishError, preStepFetch, readFetch, retryAfter } from "./types";

// Keep in step with routes/oauth.ts and the Docker app's GRAPH_VERSION.
export const GRAPH = "https://graph.facebook.com/v19.0";

const MAX_ITEMS = 10;
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 15;
// Graph error codes for "slow down": app/user/page rate limits.
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/** Classifies a failed Graph call. Code 190 is an expired or revoked token. */
async function graphFail(response: Response, what: string, isFinal: boolean): Promise<never> {
  const text = (await response.text().catch(() => "")).slice(0, 400);
  let code: number | undefined;
  try {
    code = (JSON.parse(text) as { error?: { code?: number } }).error?.code;
  } catch {
    // Not JSON; classify by status alone.
  }
  let kind: PublishFailureKind;
  if (code === 190 || response.status === 401) kind = "auth";
  else if (response.status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) kind = "transient";
  else if (response.status >= 500 || (response.status >= 300 && response.status < 400)) kind = isFinal ? "ambiguous" : "transient";
  else kind = "rejected";
  throw new PublishError(kind, `${what} failed (${response.status}): ${text}`, retryAfter(response));
}

async function postJson(url: string, body: Record<string, unknown>, what: string): Promise<Record<string, any>> {
  const response = await preStepFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, what);
  if (!response.ok) await graphFail(response, what, false);
  return (await response.json().catch(() => ({}))) as Record<string, any>;
}

// A container is processed asynchronously; publishing before FINISHED fails (error 9007).
async function waitForContainer(id: string, token: string): Promise<void> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
    const response = await readFetch(`${GRAPH}/${id}?fields=status_code&access_token=${encodeURIComponent(token)}`);
    if (!response.ok) await graphFail(response, "Instagram container status check", false);
    const { status_code: status } = (await response.json().catch(() => ({}))) as { status_code?: string };
    if (status === "FINISHED") return;
    if (status === "ERROR" || status === "EXPIRED") throw new PublishError("rejected", "Instagram could not process the uploaded media");
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new PublishError("transient", "Timed out waiting for Instagram to process the media");
}

export const instagram: PlatformAdapter = {
  async publish(post) {
    const igUserId = post.externalAccountId;
    if (!igUserId) throw new PublishError("rejected", "Instagram account is missing its id");
    const items = post.media.slice(0, MAX_ITEMS);
    if (items.length === 0) throw new PublishError("rejected", "Instagram requires an image attached to the post");
    const origin = post.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
    if (!origin) throw new PublishError("rejected", "PUBLIC_BASE_URL is not set, so Instagram cannot fetch the image from this server.");
    // Instagram only takes JPEG. The Docker app converts other formats; this deployment has no image converter yet.
    const unsupported = items.find((item) => item.contentType !== "image/jpeg");
    if (unsupported) {
      throw new PublishError("rejected", `Instagram only accepts JPEG images; this post has a ${unsupported.contentType} file. Re-attach it as a JPEG.`);
    }

    const token = post.accessToken;
    // Everything up to media_publish only prepares containers Instagram discards if unused, so it is safe to retry.
    let creationId: string;
    if (items.length === 1) {
      const only = items[0]!;
      const container = await postJson(
        `${GRAPH}/${igUserId}/media`,
        { image_url: `${origin}/uploads/${only.path}`, caption: post.content, access_token: token, ...(only.altText ? { alt_text: only.altText } : {}) },
        "Instagram media creation",
      );
      if (typeof container.id !== "string") throw new PublishError("transient", "Instagram media creation returned no id");
      creationId = container.id;
    } else {
      const children: string[] = [];
      for (const item of items) {
        const child = await postJson(
          `${GRAPH}/${igUserId}/media`,
          { image_url: `${origin}/uploads/${item.path}`, is_carousel_item: true, access_token: token, ...(item.altText ? { alt_text: item.altText } : {}) },
          "Instagram carousel item creation",
        );
        if (typeof child.id !== "string") throw new PublishError("transient", "Instagram carousel item returned no id");
        await waitForContainer(child.id, token);
        children.push(child.id);
      }
      const carousel = await postJson(
        `${GRAPH}/${igUserId}/media`,
        { media_type: "CAROUSEL", children, caption: post.content, access_token: token },
        "Instagram carousel creation",
      );
      if (typeof carousel.id !== "string") throw new PublishError("transient", "Instagram carousel creation returned no id");
      creationId = carousel.id;
    }
    await waitForContainer(creationId, token);

    // The final create: no idempotency key exists, so a lost response is ambiguous and never retried.
    let response: Response;
    try {
      response = await fetch(`${GRAPH}/${igUserId}/media_publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creation_id: creationId, access_token: token }),
        signal: AbortSignal.timeout(20_000),
        redirect: "manual",
      });
    } catch (error) {
      throw new PublishError("ambiguous", `Instagram publish: no response (${error instanceof Error ? error.message : String(error)}); the post may have been created`);
    }
    if (!response.ok) await graphFail(response, "Instagram publish", true);
    const data = (await response.json().catch(() => ({}))) as { id?: string };
    if (!data.id) throw new PublishError("ambiguous", "Instagram accepted the post but returned no id");
    return data.id;
  },

  // Likes and comments only; impressions and reach need the insights permission.
  async fetchMetrics(target) {
    const url = `${GRAPH}/${encodeURIComponent(target.platformPostId)}?fields=like_count,comments_count&access_token=${encodeURIComponent(target.accessToken)}`;
    const response = await readFetch(url);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Instagram media lookup failed (${response.status}): ${(await response.text().catch(() => "")).slice(0, 300)}`);
    const data = (await response.json().catch(() => ({}))) as Record<string, any>;
    return { views: null, likes: data.like_count ?? null, comments: data.comments_count ?? null, shares: null };
  },
};
