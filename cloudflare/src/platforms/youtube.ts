import { freshAccessToken } from "../lib/oauth-refresh";
import { type PlatformAdapter, PublishError, failPreStep, preStepFetch, readFetch, retryAfter, statusKind } from "./types";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
// Resumable chunks must be multiples of 256 KiB (except the last). 8 MiB keeps memory small.
const CHUNK_BYTES = 8 * 1024 * 1024;

export function googleRefreshRequest(env: Env) {
  return {
    tokenUrl: GOOGLE_TOKEN_URL,
    form: (refreshToken: string) => ({
      client_id: env.GOOGLE_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  };
}

// YouTube rejects '<' and '>' in titles and caps them at 100 characters.
function cleanTitle(text: string): string {
  return text.replace(/[<>]/g, "").trim().slice(0, 100) || "Untitled";
}

export const youtube: PlatformAdapter = {
  // Video only, over the Data API's resumable protocol: an init request with the metadata,
  // then the bytes in chunks. Nothing exists on YouTube until the last chunk lands, so init and
  // intermediate chunks are safe to retry; only the last chunk is the final create. Title,
  // visibility and made-for-kids are the composer's choices (platform_options.youtube); without
  // them the video uploads as private. Until the Google Cloud project passes YouTube's API
  // audit, YouTube forces every upload to private whatever is requested here.
  async publish(post) {
    const video = post.media.find((item) => item.contentType.startsWith("video/"));
    if (!video) throw new PublishError("rejected", "YouTube posts need a video attached.");
    const options = post.platformOptions;
    const token = await freshAccessToken(post, googleRefreshRequest(post.env));

    const init = await preStepFetch(
      UPLOAD_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": video.contentType,
          "X-Upload-Content-Length": String(video.size),
        },
        body: JSON.stringify({
          snippet: { title: cleanTitle(options.title || post.content), description: post.content },
          status: { privacyStatus: options.privacy_status || "private", selfDeclaredMadeForKids: Boolean(options.made_for_kids) },
        }),
      },
      "YouTube upload init",
    );
    if (!init.ok) await failPreStep(init, "YouTube upload init");
    const uploadUrl = init.headers.get("location");
    if (!uploadUrl) throw new PublishError("transient", "YouTube did not return a resumable upload URL");

    const size = video.size;
    const count = Math.max(1, Math.ceil(size / CHUNK_BYTES));
    for (let index = 0; index < count; index += 1) {
      const first = index * CHUNK_BYTES;
      const length = Math.min(CHUNK_BYTES, size - first);
      const last = first + length - 1;
      const isLast = index === count - 1;
      const chunk = count === 1 ? await video.read() : await video.readRange(first, length);
      const init = {
        method: "PUT",
        headers: { "Content-Type": video.contentType, "Content-Range": `bytes ${first}-${last}/${size}` },
        body: chunk,
      };
      const what = `YouTube video upload (chunk ${index + 1}/${count})`;

      if (!isLast) {
        const response = await preStepFetch(uploadUrl, init, what);
        // 308 "Resume Incomplete" is the expected answer to a non-final chunk.
        if (response.status !== 308) {
          if (!response.ok) await failPreStep(response, what);
          continue;
        }
        const received = response.headers.get("range");
        if (received && received !== `bytes=0-${last}`) throw new PublishError("transient", `${what}: YouTube acknowledged ${received}, expected up to byte ${last}`);
        continue;
      }

      let response: Response;
      try {
        response = await fetch(uploadUrl, { ...init, signal: AbortSignal.timeout(60_000), redirect: "manual" });
      } catch (error) {
        throw new PublishError("ambiguous", `${what}: no response (${error instanceof Error ? error.message : String(error)}); the video may have been created`);
      }
      if (response.status === 308) throw new PublishError("transient", `${what}: YouTube reports the upload incomplete`);
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        throw new PublishError(statusKind(response.status, true), `${what} failed (${response.status}): ${detail}`, retryAfter(response));
      }
      const data = (await response.json().catch(() => ({}))) as { id?: string };
      if (!data.id) throw new PublishError("ambiguous", "YouTube accepted the upload but returned no video id");
      return data.id;
    }
    throw new PublishError("transient", "YouTube upload ended without completing");
  },

  // The Data API's statistics part needs no extra permission.
  async fetchMetrics(target) {
    const token = await freshAccessToken(target, googleRefreshRequest(target.env));
    const response = await readFetch(`${API}/videos?part=statistics&id=${encodeURIComponent(target.platformPostId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`YouTube video lookup failed (${response.status})`);
    const stats = ((await response.json().catch(() => ({}))) as { items?: { statistics?: Record<string, string> }[] }).items?.[0]?.statistics;
    if (!stats) return null;
    const count = (value: string | undefined) => (value != null ? Number(value) : null);
    return { views: count(stats.viewCount), likes: count(stats.likeCount), comments: count(stats.commentCount), shares: null };
  },
};
