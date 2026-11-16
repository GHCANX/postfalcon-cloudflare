export type AccountUpsert = {
  userId: number;
  platform: string;
  displayName: string;
  externalId: string;
  accessToken: string;
  refreshToken?: string | null;
  tokenExpiresAt?: number | null;
  metadata?: Record<string, unknown>;
  avatarUrl?: string | null;
};

/**
 * Inserts a connected account, or refreshes the credential of one already
 * connected for the same external id (a reconnect). A refreshed token clears
 * the needs-reconnect flag through the schema trigger.
 */
export async function upsertAccount(database: D1Database, account: AccountUpsert): Promise<{ id: number; inserted: boolean }> {
  const existing = await database
    .prepare("SELECT id FROM social_accounts WHERE user_id = ? AND platform = ? AND external_account_id = ?")
    .bind(account.userId, account.platform, account.externalId)
    .first<{ id: number }>();
  const metadata = JSON.stringify(account.metadata ?? {});

  if (existing) {
    await database
      .prepare(
        `UPDATE social_accounts SET display_name = ?, access_token = ?, refresh_token = ?, token_expires_at = ?,
                metadata_json = ?, avatar_url = ? WHERE id = ?`,
      )
      .bind(
        account.displayName,
        account.accessToken,
        account.refreshToken ?? null,
        account.tokenExpiresAt ?? null,
        metadata,
        account.avatarUrl ?? null,
        existing.id,
      )
      .run();
    return { id: existing.id, inserted: false };
  }

  const row = await database
    .prepare(
      `INSERT INTO social_accounts (user_id, platform, display_name, external_account_id, access_token,
                                    refresh_token, token_expires_at, metadata_json, avatar_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      account.userId,
      account.platform,
      account.displayName,
      account.externalId,
      account.accessToken,
      account.refreshToken ?? null,
      account.tokenExpiresAt ?? null,
      metadata,
      account.avatarUrl ?? null,
    )
    .first<{ id: number }>();
  if (!row) throw new Error("Account insert returned no row");
  return { id: row.id, inserted: true };
}
