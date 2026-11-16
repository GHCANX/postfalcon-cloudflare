import { type PlatformAdapter, failPreStep, finalCreateFetch, PublishError, preStepFetch, readFetch } from "./types";

const MAX_IMAGES = 4;

export const mastodon: PlatformAdapter = {
  async publish(post) {
    const instance = post.metadata.instance;
    if (typeof instance !== "string" || !instance) {
      throw new PublishError("rejected", "Mastodon account is missing its instance metadata");
    }
    const auth = { Authorization: `Bearer ${post.accessToken}` };

    const mediaIds: string[] = [];
    for (const item of post.media.slice(0, MAX_IMAGES)) {
      const form = new FormData();
      form.append("file", new Blob([await item.read()], { type: item.contentType }), "image");
      if (item.altText) form.append("description", item.altText);
      const response = await preStepFetch(`https://${instance}/api/v2/media`, { method: "POST", headers: auth, body: form }, "Mastodon media upload");
      if (!response.ok) await failPreStep(response, "Mastodon media upload");
      const data = (await response.json().catch(() => ({}))) as { id?: string };
      if (!data.id) throw new PublishError("transient", "Mastodon media upload returned no id");
      mediaIds.push(data.id);
    }

    // Mastodon deduplicates on Idempotency-Key, so even a repeated create
    // returns the same status. We still never auto-retry an ambiguous result.
    const response = await finalCreateFetch(
      `https://${instance}/api/v1/statuses`,
      {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": post.idempotencyKey },
        body: JSON.stringify({ status: post.content, media_ids: mediaIds.length ? mediaIds : undefined }),
      },
      "Mastodon post",
    );
    const data = (await response.json().catch(() => ({}))) as { id?: string };
    if (!data.id) throw new PublishError("ambiguous", "Mastodon accepted the post but returned no id");
    return data.id;
  },

  // Mastodon has no "views" for a status: likes, replies and boosts only.
  async fetchMetrics(target) {
    const instance = target.metadata.instance;
    if (typeof instance !== "string" || !instance) return null;
    const response = await readFetch(`https://${instance}/api/v1/statuses/${encodeURIComponent(target.platformPostId)}`, {
      headers: { Authorization: `Bearer ${target.accessToken}` },
    });
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new Error(`Mastodon status lookup failed (${response.status})`);
    const data = (await response.json().catch(() => ({}))) as Record<string, any>;
    return { views: null, likes: data.favourites_count ?? null, comments: data.replies_count ?? null, shares: data.reblogs_count ?? null };
  },
};
