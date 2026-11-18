import { PublishError } from "../platforms/types";

const REFRESH_MARGIN_SECONDS = 120;
const TIMEOUT_MS = 15_000;

export async function saveAccountTokens(
  database: D1Database,
  accountId: number,
  accessToken: string,
  refreshToken: string | null,
  expiresAt: number | null,
): Promise<void> {
  // A new access token clears needs-reconnect through the schema trigger.
  await database
    .prepare("UPDATE social_accounts SET access_token = ?, refresh_token = COALESCE(?, refresh_token), token_expires_at = ? WHERE id = ?")
    .bind(accessToken, refreshToken, expiresAt, accountId)
    .run();
}

export type RefreshableAccount = {
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: number | null;
  saveTokens: (accessToken: string, refreshToken: string | null, expiresAt: number | null) => Promise<void>;
};

/**
 * Returns a usable access token, refreshing and persisting it first when it is
 * expired or about to be. Used by platforms with short-lived tokens (TikTok).
 * A refresh request creates nothing on the platform, so network and 5xx failures
 * are `transient`; a refused refresh token (`invalid_grant`, 400/401) means the
 * user must reconnect (`auth`).
 */
export async function freshAccessToken(
  account: RefreshableAccount,
  request: { tokenUrl: string; form: (refreshToken: string) => Record<string, string>; headers?: Record<string, string> },
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  if (account.accessToken && account.tokenExpiresAt !== null && account.tokenExpiresAt - now > REFRESH_MARGIN_SECONDS) {
    return account.accessToken;
  }
  if (!account.refreshToken) throw new PublishError("auth", "This account has no refresh token; reconnect it.");

  let response: Response;
  try {
    response = await fetch(request.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...request.headers },
      body: new URLSearchParams(request.form(account.refreshToken)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual",
    });
  } catch (error) {
    throw new PublishError("transient", `Token refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok || typeof data.access_token !== "string") {
    const detail = String(data.error_description ?? data.error?.message ?? data.error ?? "unknown").slice(0, 200);
    const refused = response.status === 400 || response.status === 401 || data.error === "invalid_grant";
    throw new PublishError(refused ? "auth" : "transient", `Token refresh failed (${response.status}): ${detail}`);
  }

  const expiresAt = typeof data.expires_in === "number" ? now + data.expires_in : null;
  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : account.refreshToken;
  await account.saveTokens(data.access_token, refreshToken, expiresAt);
  return data.access_token;
}
