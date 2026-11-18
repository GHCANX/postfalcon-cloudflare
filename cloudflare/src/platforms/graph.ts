import { type PublishFailureKind, PublishError, retryAfter } from "./types";

// Graph error codes for "slow down": app/user/page rate limits.
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/** Classifies a failed Graph call (Meta and Threads share the error shape). Code 190 is an expired or revoked token. */
export async function graphFail(response: Response, what: string, isFinal: boolean): Promise<never> {
  const text = (await response.text().catch(() => "")).slice(0, 400);
  let code: number | undefined;
  try {
    code = (JSON.parse(text) as { error?: { code?: number } }).error?.code;
  } catch {
    // Not JSON; classify by status alone.
  }
  let kind: PublishFailureKind;
  if (code === 190 || response.status === 401) kind = "auth";
  else if (response.status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) kind = "transient";
  else if (response.status >= 500 || (response.status >= 300 && response.status < 400)) kind = isFinal ? "ambiguous" : "transient";
  else kind = "rejected";
  throw new PublishError(kind, `${what} failed (${response.status}): ${text}`, retryAfter(response));
}

/**
 * The final create call of a Graph publish (JSON body or multipart form): no
 * idempotency key exists, so a lost response or a 5xx is ambiguous and never
 * retried. Returns the OK response.
 */
export async function graphFinalPost(url: string, body: Record<string, unknown> | FormData, what: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      ...(body instanceof FormData ? { body } : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(body instanceof FormData ? 60_000 : 20_000),
      redirect: "manual",
    });
  } catch (error) {
    throw new PublishError("ambiguous", `${what}: no response (${error instanceof Error ? error.message : String(error)}); the post may have been created`);
  }
  if (!response.ok) await graphFail(response, what, true);
  return response;
}
