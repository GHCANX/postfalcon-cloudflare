import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type ApiCall = (path: string, init?: RequestInit) => Promise<Response>;

const STATUSES = ["draft", "scheduled", "posting", "posted", "failed", "canceled", "review_required"] as const;

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

/**
 * The MCP tools. Each is a thin call into this Worker's own REST API (the
 * `call` function dispatches in-process with the caller's Bearer token), so
 * authorization, validation and limits live in one place and the MCP surface
 * can never do more than the token's owner can already do over REST.
 */
export function createMcpServer(call: ApiCall): McpServer {
  async function api(path: string, init?: RequestInit) {
    const response = await call(path, init);
    if (!response.ok) throw new Error(`Postfalcon API error (${response.status}): ${(await response.text().catch(() => "")).slice(0, 500)}`);
    return response.status === 204 ? null : response.json();
  }
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const server = new McpServer({ name: "postfalcon", version: "1.0.0" });

  server.tool("list_accounts", "List the connected social media accounts available to post to", {}, async () =>
    textResult(await api("/api/v1/social-accounts")),
  );

  server.tool(
    "list_posts",
    "List posts, optionally filtered by status or connected account",
    {
      status: z.enum(STATUSES).optional().describe("Only return posts in this status"),
      social_account_id: z.coerce.number().optional().describe("Only return posts for this connected account"),
    },
    async ({ status, social_account_id }) => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (social_account_id) params.set("social_account_id", String(social_account_id));
      return textResult(await api(`/api/v1/posts${params.size ? `?${params}` : ""}`));
    },
  );

  server.tool(
    "create_post",
    "Create a new text post: saved as a draft, scheduled for a specific time, or published right away. Does not support attaching media; use the Postfalcon API for image posts.",
    {
      social_account_id: z.coerce.number().describe("The connected account to post to (use list_accounts to find one)"),
      content: z.string().min(1).describe("The text content of the post"),
      scheduled_for: z.string().datetime().optional().describe("ISO 8601 UTC datetime to schedule the post for; omit to save as a draft instead"),
      publish_now: z.boolean().optional().describe("true to publish immediately (within a minute) instead of scheduling; leave out scheduled_for"),
    },
    async (input) => textResult(await api("/api/v1/posts", json("POST", input))),
  );

  server.tool(
    "update_post",
    "Update an existing draft or scheduled post's content, status, or schedule time",
    {
      post_id: z.coerce.number().describe("The ID of the post to update"),
      content: z.string().min(1).optional(),
      status: z.enum(["draft", "scheduled", "canceled"]).optional(),
      scheduled_for: z.string().datetime().nullable().optional().describe("ISO 8601 UTC datetime, or null to unschedule and revert to a draft"),
    },
    async ({ post_id, ...updates }) => textResult(await api(`/api/v1/posts/${post_id}`, json("PATCH", updates))),
  );

  server.tool(
    "delete_post",
    "Permanently delete a post",
    { post_id: z.coerce.number().describe("The ID of the post to delete") },
    async ({ post_id }) => {
      await api(`/api/v1/posts/${post_id}`, { method: "DELETE" });
      return textResult(`Post ${post_id} deleted.`);
    },
  );

  return server;
}
