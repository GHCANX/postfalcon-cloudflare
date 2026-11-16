-- Short-lived, single-use OAuth state for connect flows. The state value
-- itself is only ever stored hashed.
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json)),
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_oauth_states_expiry ON oauth_states (expires_at);

-- A Mastodon client registration is only valid for the redirect URI it was
-- registered with, so remember which one that was.
ALTER TABLE mastodon_apps ADD COLUMN redirect_uri TEXT;
