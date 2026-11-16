/**
 * How a failed publish must be treated. This is the duplicate-post boundary:
 *
 *  - `transient`: nothing was posted (a step before the final create failed, or
 *    the platform asked us to slow down), so retrying later is safe.
 *  - `rejected`: the platform refused the post; retrying will not help.
 *  - `auth`: the platform no longer accepts the account's credentials; the
 *    account needs reconnecting.
 *  - `budget`: the R2 read budget is spent, so the attached media cannot be
 *    read. Nothing was posted; the post is held (`budget_hold`) and resumes when
 *    the budget allows, instead of failing.
 *  - `ambiguous`: the final create request may or may not have been applied
 *    (timeout, dropped connection, 5xx). Never retried automatically; the post
 *    goes to manual review.
 */
export type PublishFailureKind = "transient" | "rejected" | "auth" | "ambiguous" | "budget";

export class PublishError extends Error {
  constructor(
    readonly kind: PublishFailureKind,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

export type PublishMedia = {
  /** File name under /uploads/ (the public URL is `<origin>/uploads/<path>`). */
  path: string;
  contentType: string;
  altText: string | null;
  /** Stored size in bytes. */
  size: number;
  /** Reads the whole file (budgeted against R2 Class B operations). Refuses files too large to hold in memory. */
  read: () => Promise<ArrayBuffer>;
  /** Reads one byte range, for platforms that upload in chunks (one Class B operation per call). */
  readRange: (offset: number, length: number) => Promise<ArrayBuffer>;
};

export type PublishPost = {
  postId: number;
  /** Stable per post and schedule; usable as a platform idempotency key. */
  idempotencyKey: string;
  content: string;
  accessToken: string;
  /** For platforms with expiring access tokens (TikTok). */
  refreshToken: string | null;
  tokenExpiresAt: number | null;
  /** Persists a refreshed credential on the account (a rotated refresh token replaces the old one). */
  saveTokens: (accessToken: string, refreshToken: string | null, expiresAt: number | null) => Promise<void>;
  /** Worker bindings and operator secrets (platform app credentials, public origin). */
  env: Env;
  externalAccountId: string | null;
  metadata: Record<string, any>;
  platformOptions: Record<string, any>;
  media: PublishMedia[];
};

export type PostMetrics = { views: number | null; likes: number | null; comments: number | null; shares: number | null };

export type MetricsTarget = {
  platformPostId: string;
  accessToken: string;
  externalAccountId: string | null;
  metadata: Record<string, any>;
};

export type PlatformAdapter = {
  /** Returns the platform's id for the new post. Throws PublishError. */
  publish(post: PublishPost): Promise<string>;
  /** Engagement counts (null for what the platform doesn't report); null if the post is gone. */
  fetchMetrics?(target: MetricsTarget): Promise<PostMetrics | null>;
};

const REQUEST_TIMEOUT_MS = 20_000;

export async function readFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "manual" });
}

/** A request that happens before the final create: failures are safe to retry. */
export async function preStepFetch(url: string, init: RequestInit, what: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "manual" });
  } catch (error) {
    throw new PublishError("transient", `${what} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return response;
}

/** Maps a non-OK response from a pre-create step. */
export async function failPreStep(response: Response, what: string): Promise<never> {
  const detail = (await response.text().catch(() => "")).slice(0, 300);
  throw new PublishError(statusKind(response.status, false), `${what} failed (${response.status}): ${detail}`, retryAfter(response));
}

/**
 * The final create request. A thrown fetch error or a 5xx means the platform
 * may have applied it, so it is ambiguous; a 4xx is a definite answer.
 */
export async function finalCreateFetch(url: string, init: RequestInit, what: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "manual" });
  } catch (error) {
    throw new PublishError("ambiguous", `${what}: no response (${error instanceof Error ? error.message : String(error)}); the post may have been created`);
  }
  if (response.ok) return response;
  const detail = (await response.text().catch(() => "")).slice(0, 300);
  throw new PublishError(statusKind(response.status, true), `${what} failed (${response.status}): ${detail}`, retryAfter(response));
}

export function statusKind(status: number, isFinal: boolean): PublishFailureKind {
  if (status === 401) return "auth";
  if (status === 429) return "transient"; // refused before processing
  if (status >= 500 || (status >= 300 && status < 400)) return isFinal ? "ambiguous" : "transient";
  return "rejected";
}

export function retryAfter(response: Response): number | undefined {
  const value = Number(response.headers.get("retry-after"));
  return Number.isFinite(value) && value > 0 ? Math.min(value, 3600) : undefined;
}
