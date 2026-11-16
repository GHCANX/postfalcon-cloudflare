import { freshAccessToken } from "../lib/oauth-refresh";
import { type PlatformAdapter, type PublishPost, PublishError, failPreStep, preStepFetch, readFetch } from "./types";

export const TIKTOK_API = "https://open.tiktokapis.com";
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 20;
// One chunk covers any video this deployment can store (media is capped at 25 MiB);
// TikTok allows a single chunk up to 64 MiB.
const MAX_SINGLE_CHUNK_BYTES = 64 * 1024 * 1024;

export function tiktokRefreshRequest(env: Env) {
  return {
    tokenUrl: `${TIKTOK_API}/v2/oauth/token/`,
    form: (refreshToken: string) => ({
      client_key: env.TIKTOK_CLIENT_KEY ?? "",
      client_secret: env.TIKTOK_CLIENT_SECRET ?? "",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  };
}

/**
 * Required by TikTok's Content Sharing Guidelines before every publish, and
 * also shown in the composer so the user sees who they post as and which
 * privacy levels they may choose.
 */
export async function queryCreatorInfo(token: string): Promise<Record<string, any>> {
  const response = await preStepFetch(
    `${TIKTOK_API}/v2/post/publish/creator_info/query/`,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" } },
    "TikTok creator_info query",
  );
  const data = (await response.json().catch(() => ({}))) as { data?: Record<string, any>; error?: { code?: string; message?: string } };
  if (!response.ok || data.error?.code !== "ok") {
    const detail = data.error?.message ?? "unknown";
    const kind = response.status === 401 || data.error?.code === "access_token_invalid" ? "auth" : response.status >= 500 ? "transient" : "rejected";
    throw new PublishError(kind, `TikTok creator_info query failed (${response.status}): ${detail}`);
  }
  return data.data ?? {};
}

// The user's choices from the composer (platform_options.tiktok). With none, the post goes
// out as the most conservative option: private, interactions off, no commercial disclosure.
function resolvePostInfo(post: PublishPost, creatorInfo: Record<string, any>) {
  const options = post.platformOptions;
  const offered: string[] = creatorInfo.privacy_level_options ?? [];

  let privacy: string | undefined = options.privacy_level;
  if (privacy && !offered.includes(privacy)) {
    throw new PublishError("rejected", `TikTok no longer offers the privacy level chosen for this post (${privacy}); edit the post and pick another.`);
  }
  if (!privacy) {
    if (!offered.includes("SELF_ONLY")) throw new PublishError("rejected", "No TikTok privacy level was chosen for this post; edit it and pick who can view it.");
    privacy = "SELF_ONLY";
  }
  if (options.brand_content && privacy === "SELF_ONLY") {
    throw new PublishError("rejected", "Branded content on TikTok cannot be private; edit the post and pick another privacy level.");
  }
  return {
    title: post.content.slice(0, 2200),
    privacy_level: privacy,
    // The creator's own account settings win over the post's request.
    disable_comment: Boolean(creatorInfo.comment_disabled) || !options.allow_comment,
    disable_duet: Boolean(creatorInfo.duet_disabled) || !options.allow_duet,
    disable_stitch: Boolean(creatorInfo.stitch_disabled) || !options.allow_stitch,
    brand_organic_toggle: Boolean(options.brand_organic),
    brand_content_toggle: Boolean(options.brand_content),
  };
}

export const tiktok: PlatformAdapter = {
  // Video only, through the Content Posting API: init, PUT the file to the returned
  // upload URL, then poll for completion. Nothing is public until TikTok finishes
  // processing, so init and upload are safe to retry; only an unresolved poll is ambiguous.
  async publish(post) {
    const video = post.media.find((item) => item.contentType.startsWith("video/"));
    if (!video) throw new PublishError("rejected", "TikTok posts need a video attached.");

    const token = await freshAccessToken(post, tiktokRefreshRequest(post.env));
    const creatorInfo = await queryCreatorInfo(token);
    if (!creatorInfo.privacy_level_options?.length) {
      throw new PublishError("rejected", "This TikTok creator cannot post right now (no privacy level options available).");
    }
    const postInfo = resolvePostInfo(post, creatorInfo);

    const bytes = await video.read();
    const size = bytes.byteLength;
    if (size > MAX_SINGLE_CHUNK_BYTES) throw new PublishError("rejected", "The video is too large for a single TikTok upload.");

    const init = await preStepFetch(
      `${TIKTOK_API}/v2/post/publish/video/init/`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ post_info: postInfo, source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: size, total_chunk_count: 1 } }),
      },
      "TikTok publish init",
    );
    const initData = (await init.json().catch(() => ({}))) as { data?: { publish_id?: string; upload_url?: string }; error?: { code?: string; message?: string } };
    if (!init.ok || initData.error?.code !== "ok" || !initData.data?.publish_id || !initData.data.upload_url) {
      throw new PublishError(init.status >= 500 ? "transient" : init.status === 401 ? "auth" : "rejected", `TikTok publish init failed (${init.status}): ${initData.error?.message ?? "unknown"}`);
    }
    const { publish_id: publishId, upload_url: uploadUrl } = initData.data;

    const upload = await preStepFetch(
      uploadUrl,
      { method: "PUT", headers: { "Content-Type": video.contentType, "Content-Range": `bytes 0-${size - 1}/${size}` }, body: bytes },
      "TikTok video upload",
    );
    if (!upload.ok) await failPreStep(upload, "TikTok video upload");

    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
      const response = await readFetch(`${TIKTOK_API}/v2/post/publish/status/fetch/`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ publish_id: publishId }),
      }).catch(() => null);
      const data = (await response?.json().catch(() => ({}))) as { data?: { status?: string; fail_reason?: string } } | undefined;
      const status = data?.data?.status;
      if (status === "PUBLISH_COMPLETE") return publishId;
      if (status === "FAILED") throw new PublishError("rejected", `TikTok publish failed: ${data?.data?.fail_reason ?? "unknown reason"}`);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    // The upload finished, so TikTok may still publish it: never retry automatically.
    throw new PublishError("ambiguous", `TikTok had not confirmed publish ${publishId} after waiting; check the TikTok app before retrying.`);
  },
};
