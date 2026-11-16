import { base64Url, hmacHex, randomBytes, timingSafeEqualStrings } from "./crypto";
import { firstCookieValue } from "./sessions";

// Double-submit token, the same contract the browser code already uses: the
// page fetches GET /api/csrf-token and sends the value back in `x-csrf-token`.
// The token is `<random>.<hmac>`, so a cookie planted from a sibling host
// cannot be made to validate.
export const CSRF_COOKIE_NAME = "__Host-postfalcon_csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";

async function sign(secret: string, nonce: string): Promise<string> {
  return hmacHex(secret, `csrf:${nonce}`);
}

async function isValidToken(secret: string, token: string): Promise<boolean> {
  const [nonce, signature, ...rest] = token.split(".");
  if (!nonce || !signature || rest.length > 0) return false;
  return timingSafeEqualStrings(signature, await sign(secret, nonce));
}

/** Returns the request's valid token, or a new one plus the cookie to set. */
export async function issueCsrfToken(request: Request, secret: string): Promise<{ token: string; cookie: string | null }> {
  const existing = firstCookieValue(request, CSRF_COOKIE_NAME);
  if (existing && (await isValidToken(secret, existing))) return { token: existing, cookie: null };

  const nonce = base64Url(randomBytes(24));
  const token = `${nonce}.${await sign(secret, nonce)}`;
  return { token, cookie: `${CSRF_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax` };
}

/**
 * True when a cookie-authenticated, state-changing request carries a matching
 * token and does not come from another origin.
 */
export async function passesCsrfCheck(request: Request, secret: string): Promise<boolean> {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return false;

  const cookie = firstCookieValue(request, CSRF_COOKIE_NAME);
  const header = request.headers.get(CSRF_HEADER_NAME);
  if (!cookie || !header) return false;
  if (!(await timingSafeEqualStrings(cookie, header))) return false;
  return isValidToken(secret, cookie);
}
