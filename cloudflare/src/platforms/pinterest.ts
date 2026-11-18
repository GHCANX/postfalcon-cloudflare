import { freshAccessToken } from "../lib/oauth-refresh";
import { type PlatformAdapter, type PublishMedia, type PublishPost, PublishError, preStepFetch, readFetch, retryAfter } from "./types";

export const PINTEREST_API = "https://api.pinterest.com";
export const PINTEREST_TOKEN_URL = `${PINTEREST_API}/v5/oauth/token`;
// Boards tried per publish before giving up on the account's existing ones and making a new one.
const MAX_BOARD_ATTEMPTS = 10;

/** Pinterest authenticates the app with HTTP Basic auth on its token endpoint. */
export function pinterestBasicAuth(env: Env): string {
  return `Basic ${btoa(`${env.PINTEREST_APP_ID ?? ""}:${env.PINTEREST_APP_SECRET ?? ""}`)}`;
}

export function pinterestRefreshRequest(env: Env) {
  return {
    tokenUrl: PINTEREST_TOKEN_URL,
    headers: { Authorization: pinterestBasicAuth(env) },
    form: (refreshToken: string) => ({ grant_type: "refresh_token", refresh_token: refreshToken }),
  };
}

/** Tokens last 30 days and renew with the refresh token. An account with no expiry on file predates that and is used as-is. */
export async function pinterestToken(
  account: { accessToken: string; refreshToken: string | null; tokenExpiresAt: number | null; saveTokens: PublishPost["saveTokens"] },
  env: Env,
): Promise<string> {
  if (account.tokenExpiresAt === null) return account.accessToken;
  return freshAccessToken(account, pinterestRefreshRequest(env));
}

export type Board = { id: string; name: string; privacy: string | null };

export async function listBoards(token: string): Promise<Board[]> {
  const response = await readFetch(`${PINTEREST_API}/v5/boards?page_size=100`, { headers: { Authorization: `Bearer ${token}` } });
  const data = (await response.json().catch(() => ({}))) as { items?: { id: unknown; name: string; privacy?: string }[] };
  if (!response.ok) throw new Error(`Pinterest boards lookup failed (${response.status}): ${JSON.stringify(data).slice(0, 300)}`);
  return (data.items ?? []).map((board) => ({ id: String(board.id), name: board.name, privacy: board.privacy ?? null }));
}

// Pinterest's answer when the board itself is the problem (deleted, archived, a sandbox leftover).
// A bad image, an expired token or a rate limit isn't fixed by trying another board.
function isBoardRejection(status: number, data: Record<string, any>): boolean {
  return [400, 403, 404].includes(status) && /board/i.test(String(data.message ?? ""));
}

type PinAttempt = { ok: true; id: string } | { ok: false; status: number; data: Record<string, any> };

// The pin create is the final call. A refusal is definite; a lost response or 5xx is ambiguous.
async function createPin(token: string, boardId: string, description: string, imageUrl: string): Promise<PinAttempt> {
  let response: Response;
  try {
    response = await fetch(`${PINTEREST_API}/v5/pins`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ board_id: boardId, description, media_source: { source_type: "image_url", url: imageUrl } }),
      signal: AbortSignal.timeout(20_000),
      redirect: "manual",
    });
  } catch (error) {
    throw new PublishError("ambiguous", `Pinterest pin: no response (${error instanceof Error ? error.message : String(error)}); the pin may have been created`);
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (response.ok) {
    if (typeof data.id !== "string") throw new PublishError("ambiguous", "Pinterest accepted the pin but returned no id");
    return { ok: true, id: data.id };
  }
  if (isBoardRejection(response.status, data)) return { ok: false, status: response.status, data };
  const kind = response.status === 401 ? "auth" : response.status === 429 ? "transient" : response.status >= 500 ? "ambiguous" : "rejected";
  throw new PublishError(kind, `Pinterest pin failed (${response.status}): ${JSON.stringify(data).slice(0, 300)}`, retryAfter(response));
}

async function createBoard(token: string, existing: Board[]): Promise<Board | null> {
  const taken = new Set(existing.map((board) => board.name.toLowerCase()));
  const name = ["Postfalcon", "Postfalcon Pins"].find((candidate) => !taken.has(candidate.toLowerCase())) ?? `Postfalcon ${Date.now()}`;
  const response = await preStepFetch(
    `${PINTEREST_API}/v5/boards`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: "Pins published with Postfalcon", privacy: "PUBLIC" }),
    },
    "Pinterest board creation",
  ).catch(() => null);
  const data = (await response?.json().catch(() => null)) as { id?: unknown; name?: string } | null;
  return response?.ok && data?.id ? { id: String(data.id), name: data.name ?? name, privacy: "PUBLIC" } : null;
}

// The saved board was refused: try the account's other boards, then a new one, and keep whichever works.
async function pinToAnotherBoard(post: PublishPost, token: string, imageUrl: string, first: { status: number; data: Record<string, any> }): Promise<string> {
  const unusable = new Set<string>([...((post.metadata.unusable_board_ids as string[] | undefined) ?? []), String(post.metadata.board_id)]);
  const remember = (board: { id: string; name: string }) =>
    post.saveMetadata({ ...post.metadata, board_id: board.id, board_name: board.name, unusable_board_ids: [...unusable] });
  const boards = await listBoards(token).catch(() => [] as Board[]);

  for (const board of boards.filter((candidate) => !unusable.has(candidate.id)).slice(0, MAX_BOARD_ATTEMPTS)) {
    const attempt = await createPin(token, board.id, post.content, imageUrl);
    if (attempt.ok) {
      await remember(board);
      return attempt.id;
    }
    unusable.add(board.id);
  }
  const created = await createBoard(token, boards);
  if (created) {
    const attempt = await createPin(token, created.id, post.content, imageUrl);
    if (attempt.ok) {
      await remember(created);
      return attempt.id;
    }
  }
  throw new PublishError(
    "rejected",
    `Pinterest pin failed on every board of this account and a new board could not be created; create a board on pinterest.com, then choose it on the Accounts page (${first.status}): ${JSON.stringify(first.data).slice(0, 200)}`,
  );
}

export const pinterest: PlatformAdapter = {
  // A Pin is always an image on one board; Pinterest fetches the image from its public URL.
  async publish(post) {
    const image: PublishMedia | undefined = post.media.find((item) => item.contentType.startsWith("image/"));
    if (!image) throw new PublishError("rejected", "Pinterest pins need an image attached; video pins are not supported yet.");
    const origin = post.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
    if (!origin) throw new PublishError("rejected", "PUBLIC_BASE_URL is not set, so Pinterest cannot fetch the image from this server.");
    const boardId = post.metadata.board_id;
    if (!boardId) throw new PublishError("rejected", "This Pinterest account has no board on file; reconnect it.");

    const token = await pinterestToken(post, post.env);
    const imageUrl = `${origin}/uploads/${image.path}`;
    const attempt = await createPin(token, String(boardId), post.content, imageUrl);
    if (attempt.ok) return attempt.id;
    return pinToAnotherBoard(post, token, imageUrl, attempt);
  },
};
