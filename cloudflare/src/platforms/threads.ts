import { graphFail, graphFinalPost } from "./graph";
import { type PlatformAdapter, type PublishMedia, PublishError, preStepFetch, readFetch } from "./types";

const THREADS = "https://graph.threads.net/v1.0";
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 15;
const MAX_ITEMS = 20;
// The long-lived token lasts ~60 days and is refreshed by presenting itself;
// refresh with a week of runway left.
const REFRESH_MARGIN_SECONDS = 7 * 24 * 60 * 60;

type TokenAccount = {
  accessToken: string;
  tokenExpiresAt: number | null;
  saveTokens: (accessToken: string, refreshToken: string | null, expiresAt: number | null) => Promise<void>;
};

async function freshToken(account: TokenAccount, now = Math.floor(Date.now() / 1000)): Promise<string> {
  if (account.tokenExpiresAt !== null && account.tokenExpiresAt - now > REFRESH_MARGIN_SECONDS) return account.accessToken;
  const url = new URL("https://graph.threads.net/refresh_access_token");
  url.searchParams.set("grant_type", "th_refresh_token");
  url.searchParams.set("access_token", account.accessToken);
  const response = await preStepFetch(url.toString(), {}, "Threads token refresh");
  const data = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (!response.ok || !data.access_token) {
    const refused = response.status === 400 || response.status === 401 || response.status === 403;
    throw new PublishError(refused ? "auth" : "transient", `Threads token refresh failed (${response.status}): ${data.error?.message ?? "reconnect this account"}`);
  }
  const expiresAt = typeof data.expires_in === "number" ? now + data.expires_in : null;
  await account.saveTokens(data.access_token, null, expiresAt);
  return data.access_token;
}

async function createContainer(userId: string, token: string, fields: Record<string, unknown>, what: string): Promise<string> {
  const response = await preStepFetch(
    `${THREADS}/${userId}/threads`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: token, ...fields }) },
    what,
  );
  if (!response.ok) await graphFail(response, what, false);
  const data = (await response.json().catch(() => ({}))) as { id?: string };
  if (!data.id) throw new PublishError("transient", `${what} returned no id`);
  return data.id;
}

// A container is processed asynchronously (especially video); publishing before FINISHED fails.
async function waitForContainer(id: string, token: string): Promise<void> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
    const response = await readFetch(`${THREADS}/${id}?fields=status,error_message&access_token=${encodeURIComponent(token)}`);
    if (!response.ok) await graphFail(response, "Threads container status check", false);
    const data = (await response.json().catch(() => ({}))) as { status?: string; error_message?: string };
    if (data.status === "FINISHED") return;
    if (data.status === "ERROR" || data.status === "EXPIRED") {
      throw new PublishError("rejected", `Threads could not process the post: ${data.error_message ?? data.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new PublishError("transient", "Timed out waiting for Threads to process the post");
}

export const threads: PlatformAdapter = {
  async publish(post) {
    const userId = post.externalAccountId;
    if (!userId) throw new PublishError("rejected", "Threads account is missing its id");
    const origin = post.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
    const items = post.media.slice(0, MAX_ITEMS);
    if (items.length > 0 && !origin) throw new PublishError("rejected", "PUBLIC_BASE_URL is not set, so Threads cannot fetch media from this server.");
    const token = await freshToken(post);

    const mediaFields = (item: PublishMedia): Record<string, unknown> => ({
      ...(item.contentType.startsWith("video/")
        ? { media_type: "VIDEO", video_url: `${origin}/uploads/${item.path}` }
        : { media_type: "IMAGE", image_url: `${origin}/uploads/${item.path}` }),
      ...(item.altText ? { alt_text: item.altText } : {}),
    });

    // Containers are discarded by Threads if never published, so everything before threads_publish is safe to retry.
    let creationId: string;
    if (items.length === 0) {
      creationId = await createContainer(userId, token, { media_type: "TEXT", text: post.content }, "Threads post creation");
    } else if (items.length === 1) {
      creationId = await createContainer(userId, token, { ...mediaFields(items[0]!), text: post.content }, "Threads post creation");
    } else {
      const children: string[] = [];
      for (const item of items) {
        const child = await createContainer(userId, token, { ...mediaFields(item), is_carousel_item: true }, "Threads carousel item creation");
        await waitForContainer(child, token);
        children.push(child);
      }
      creationId = await createContainer(userId, token, { media_type: "CAROUSEL", children, text: post.content }, "Threads carousel creation");
    }
    await waitForContainer(creationId, token);

    const response = await graphFinalPost(`${THREADS}/${userId}/threads_publish`, { creation_id: creationId, access_token: token }, "Threads publish");
    const data = (await response.json().catch(() => ({}))) as { id?: string };
    if (!data.id) throw new PublishError("ambiguous", "Threads accepted the post but returned no id");
    return data.id;
  },

  // Threads reports views even for text-only posts.
  async fetchMetrics(target) {
    const token = await freshToken(target);
    const url = `${THREADS}/${encodeURIComponent(target.platformPostId)}/insights?metric=views,likes,replies,reposts&access_token=${encodeURIComponent(token)}`;
    const response = await readFetch(url);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Threads insights lookup failed (${response.status}): ${(await response.text().catch(() => "")).slice(0, 300)}`);
    const data = (await response.json().catch(() => ({}))) as { data?: { name: string; values?: { value?: number }[]; total_value?: { value?: number } }[] };
    // Media insights use `values: [{ value }]`; `total_value` is the user-level shape. Accept either.
    const metric = (name: string): number | null => {
      const entry = data.data?.find((item) => item.name === name);
      return entry?.values?.[0]?.value ?? entry?.total_value?.value ?? null;
    };
    return { views: metric("views"), likes: metric("likes"), comments: metric("replies"), shares: metric("reposts") };
  },
};
