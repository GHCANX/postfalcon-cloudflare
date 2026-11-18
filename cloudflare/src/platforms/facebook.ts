import { GRAPH } from "./instagram";
import { graphFail, graphFinalPost } from "./graph";
import { type PlatformAdapter, type PublishMedia, PublishError, preStepFetch, readFetch } from "./types";

const MAX_PHOTOS = 10;

/** An unpublished photo only attaches to a later /feed post, so a failed upload is safe to retry. */
async function uploadPhoto(pageId: string, token: string, item: PublishMedia): Promise<string> {
  const form = new FormData();
  form.append("source", new Blob([await item.read()], { type: item.contentType }), item.path);
  form.append("published", "false");
  if (item.altText) form.append("alt_text_custom", item.altText);
  form.append("access_token", token);
  const response = await preStepFetch(`${GRAPH}/${pageId}/photos`, { method: "POST", body: form }, "Facebook photo upload");
  if (!response.ok) await graphFail(response, "Facebook photo upload", false);
  const data = (await response.json().catch(() => ({}))) as { id?: string };
  if (!data.id) throw new PublishError("transient", "Facebook photo upload returned no id");
  return data.id;
}

async function idOf(response: Response): Promise<string> {
  const data = (await response.json().catch(() => ({}))) as { id?: string };
  if (!data.id) throw new PublishError("ambiguous", "Facebook accepted the post but returned no id");
  return data.id;
}

export const facebook: PlatformAdapter = {
  // Posts to a Page. Facebook feed posts take one video or up to 10 photos, not both.
  async publish(post) {
    const pageId = post.externalAccountId;
    if (!pageId) throw new PublishError("rejected", "Facebook Page is missing its id");
    const token = post.accessToken;

    const video = post.media.find((item) => item.contentType.startsWith("video/"));
    if (video) {
      // The upload is the final create: there is no way to tell a half-applied one apart.
      const form = new FormData();
      form.append("source", new Blob([await video.read()], { type: video.contentType }), video.path);
      form.append("description", post.content);
      form.append("access_token", token);
      return idOf(await graphFinalPost(`${GRAPH}/${pageId}/videos`, form, "Facebook video post"));
    }

    const photos = post.media.filter((item) => item.contentType.startsWith("image/")).slice(0, MAX_PHOTOS);
    if (photos.length === 0) {
      return idOf(await graphFinalPost(`${GRAPH}/${pageId}/feed`, { message: post.content, access_token: token }, "Facebook post"));
    }
    const ids: string[] = [];
    for (const photo of photos) ids.push(await uploadPhoto(pageId, token, photo));
    return idOf(
      await graphFinalPost(
        `${GRAPH}/${pageId}/feed`,
        { message: post.content, attached_media: ids.map((id) => ({ media_fbid: id })), access_token: token },
        "Facebook post",
      ),
    );
  },

  // A /feed post is stored as a Page post id ("{pageId}_{postId}"); a video as the bare video id.
  // Video nodes have no `shares` field and asking for one fails the whole request (error #100).
  async fetchMetrics(target) {
    const isPagePost = target.platformPostId.includes("_");
    const fields = ["likes.summary(true).limit(0)", "comments.summary(true).limit(0)"];
    if (isPagePost) fields.push("shares");
    const url = `${GRAPH}/${encodeURIComponent(target.platformPostId)}?fields=${encodeURIComponent(fields.join(","))}&access_token=${encodeURIComponent(target.accessToken)}`;
    const response = await readFetch(url);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Facebook post lookup failed (${response.status}): ${(await response.text().catch(() => "")).slice(0, 300)}`);
    const data = (await response.json().catch(() => ({}))) as Record<string, any>;
    return {
      views: null,
      likes: data.likes?.summary?.total_count ?? null,
      comments: data.comments?.summary?.total_count ?? null,
      // A Page post with no shares omits the field, so that is 0, not unknown.
      shares: isPagePost ? (data.shares?.count ?? 0) : null,
    };
  },
};
