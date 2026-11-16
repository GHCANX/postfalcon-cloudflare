import { type PlatformAdapter, finalCreateFetch, PublishError } from "./types";

const API = "https://api.telegram.org";
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
};

async function call(token: string, method: string, body: BodyInit, json: boolean): Promise<any> {
  const response = await finalCreateFetch(
    `${API}/bot${token}/${method}`,
    { method: "POST", headers: json ? { "Content-Type": "application/json" } : undefined, body },
    `Telegram ${method}`,
  );
  const data = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: any };
  if (!data.ok) throw new PublishError("ambiguous", `Telegram ${method} returned an unexpected response`);
  return data.result;
}

export const telegram: PlatformAdapter = {
  async publish(post) {
    const chatId = post.externalAccountId;
    if (!chatId) throw new PublishError("rejected", "Telegram account is missing its channel/chat id");
    const token = post.accessToken;
    const media = post.media.slice(0, 10);

    // Each branch is a single request, so nothing can half-succeed.
    if (media.length === 0) {
      const result = await call(token, "sendMessage", JSON.stringify({ chat_id: chatId, text: post.content }), true);
      return String(result.message_id);
    }

    const form = new FormData();
    form.append("chat_id", chatId);
    if (media.length === 1) {
      const only = media[0]!;
      const isGif = only.contentType === "image/gif";
      const isVideo = only.contentType.startsWith("video/");
      if (post.content) form.append("caption", post.content);
      const field = isVideo ? "video" : isGif ? "animation" : "photo";
      form.append(field, new Blob([await only.read()], { type: only.contentType }), `file.${EXTENSIONS[only.contentType] ?? "jpg"}`);
      const result = await call(token, isVideo ? "sendVideo" : isGif ? "sendAnimation" : "sendPhoto", form, false);
      return String(result.message_id);
    }

    form.append(
      "media",
      JSON.stringify(
        media.map((item, index) => ({
          type: item.contentType.startsWith("video/") ? "video" : "photo",
          media: `attach://file${index}`,
          ...(index === 0 && post.content ? { caption: post.content } : {}),
        })),
      ),
    );
    for (const [index, item] of media.entries()) {
      form.append(`file${index}`, new Blob([await item.read()], { type: item.contentType }), `file${index}.${EXTENSIONS[item.contentType] ?? "jpg"}`);
    }
    const result = await call(token, "sendMediaGroup", form, false);
    return String(Array.isArray(result) ? result[0]?.message_id : result?.message_id);
  },
};
