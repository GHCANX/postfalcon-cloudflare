import { type PlatformAdapter, PublishError, finalCreateFetch } from "./types";

// The versioned Posts API with "Share on LinkedIn" (w_member_social), open to any registered app.
// Personal-profile text posts only; images and video need LinkedIn's separate asset-upload flow.
const LINKEDIN_API_VERSION = "202606";

/**
 * `commentary` is LinkedIn's "little text format", where ( ) [ ] { } < > @ * _ ~ | \ are markup:
 * left unescaped, LinkedIn truncates the post at the first one or rejects it. '#' is reserved too,
 * but escaping it would turn every hashtag into plain text, so it is left alone.
 */
export function escapeLittleText(text: string): string {
  return text.replace(/[\\|{}@[\]()<>*_~]/g, (character) => `\\${character}`);
}

export const linkedin: PlatformAdapter = {
  async publish(post) {
    if (post.media.length > 0) {
      throw new PublishError("rejected", "LinkedIn image and video posting is not supported yet; remove the attached media or post text only.");
    }
    if (!post.externalAccountId) throw new PublishError("rejected", "LinkedIn account is missing its id");
    const response = await finalCreateFetch(
      "https://api.linkedin.com/rest/posts",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${post.accessToken}`,
          "Content-Type": "application/json",
          "LinkedIn-Version": LINKEDIN_API_VERSION,
          "X-Restli-Protocol-Version": "2.0.0",
        },
        body: JSON.stringify({
          author: `urn:li:person:${post.externalAccountId}`,
          commentary: escapeLittleText(post.content),
          visibility: "PUBLIC",
          distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
          lifecycleState: "PUBLISHED",
          isReshareDisabledByAuthor: false,
        }),
      },
      "LinkedIn post",
    );
    // The new post's URN comes back in a header, not the body.
    const id = response.headers.get("x-restli-id") ?? response.headers.get("x-linkedin-id");
    if (!id) throw new PublishError("ambiguous", "LinkedIn accepted the post but returned no id");
    return id;
  },
};
