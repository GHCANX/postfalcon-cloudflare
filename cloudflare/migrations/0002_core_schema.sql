-- Consolidated D1 baseline corresponding to PostgreSQL migrations 001-032.
--
-- Timestamps are integer Unix seconds (UTC), not PostgreSQL TIMESTAMPTZ values.
-- The import tool added in the data-migration workstream is responsible for
-- converting source timestamps. JSON values are stored as validated JSON text.
-- This baseline is for a new D1 database; do not apply it to PostgreSQL.
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  email_verified_at INTEGER,
  google_id TEXT UNIQUE,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  stripe_customer_id TEXT UNIQUE,
  plan TEXT NOT NULL DEFAULT 'standard' CHECK (plan IN ('standard', 'team', 'pro')),
  plan_status TEXT NOT NULL DEFAULT 'incomplete'
    CHECK (plan_status IN ('active', 'trialing', 'past_due', 'canceled', 'incomplete')),
  plan_renews_at INTEGER,
  plan_cancels_at INTEGER,
  plan_interval TEXT CHECK (plan_interval IN ('monthly', 'yearly')),
  suspended_at INTEGER,
  onboarding_dismissed_at INTEGER,
  admin_setup_dismissed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Matches the established self-hosted behavior: only the first account gets
-- owner privileges. Identity routes will still require an explicit bootstrap
-- guard before they are enabled on the Worker.
CREATE TRIGGER users_first_account_is_admin
AFTER INSERT ON users
WHEN (SELECT count(*) FROM users) = 1
BEGIN
  UPDATE users
     SET is_admin = 1,
         plan = 'pro',
         plan_status = 'active'
   WHERE id = NEW.id;
END;

CREATE TABLE social_accounts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN (
    'facebook', 'instagram', 'mastodon', 'youtube', 'tiktok', 'telegram',
    'bluesky', 'threads', 'pinterest', 'linkedin', 'reddit',
    'google_business', 'twitter', 'x'
  )),
  display_name TEXT NOT NULL,
  external_account_id TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  avatar_url TEXT,
  needs_reconnect_at INTEGER,
  reconnect_reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (user_id, platform, external_account_id)
);

CREATE TRIGGER social_accounts_clear_reconnect_on_token_change
AFTER UPDATE OF access_token ON social_accounts
WHEN NOT (NEW.access_token IS OLD.access_token)
 AND NEW.needs_reconnect_at IS OLD.needs_reconnect_at
BEGIN
  UPDATE social_accounts
     SET needs_reconnect_at = NULL,
         reconnect_reason = NULL
   WHERE id = NEW.id;
END;

CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  social_account_id INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'scheduled', 'posting', 'posted', 'failed', 'canceled',
    'review_required', 'budget_hold'
  )),
  scheduled_for INTEGER,
  posted_at INTEGER,
  platform_post_id TEXT,
  error_message TEXT,
  repeat_interval TEXT CHECK (repeat_interval IN ('daily', 'weekly', 'monthly')),
  repeat_until INTEGER,
  repeat_parent_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  crosspost_group_id TEXT,
  platform_options_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(platform_options_json)),
  metric_views INTEGER,
  metric_likes INTEGER,
  metric_comments INTEGER,
  metric_shares INTEGER,
  metrics_updated_at INTEGER,
  workflow_instance_id TEXT UNIQUE,
  posting_lease_token TEXT,
  posting_lease_expires_at INTEGER,
  publish_attempts INTEGER NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  last_publish_attempt_at INTEGER,
  review_reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TRIGGER posts_set_updated_at
AFTER UPDATE ON posts
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE posts SET updated_at = unixepoch() WHERE id = NEW.id;
END;

CREATE INDEX idx_posts_due ON posts (scheduled_for) WHERE status = 'scheduled';
CREATE INDEX idx_posts_claim_recovery ON posts (status, posting_lease_expires_at)
  WHERE status = 'posting';
CREATE INDEX idx_posts_review_required ON posts (scheduled_for)
  WHERE status = 'review_required';
CREATE INDEX idx_posts_repeat_parent ON posts (repeat_parent_id)
  WHERE repeat_parent_id IS NOT NULL;
CREATE INDEX idx_posts_crosspost_group ON posts (crosspost_group_id)
  WHERE crosspost_group_id IS NOT NULL;
CREATE INDEX idx_posts_posted_recent ON posts (posted_at) WHERE status = 'posted';

CREATE TABLE post_media (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  r2_key TEXT UNIQUE,
  media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
  content_type TEXT,
  byte_size INTEGER CHECK (byte_size >= 0),
  alt_text TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  tombstoned_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_post_media_post_id ON post_media (post_id);
CREATE INDEX idx_post_media_tombstone ON post_media (tombstoned_at)
  WHERE tombstoned_at IS NOT NULL;

CREATE TABLE user_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('password_reset', 'email_verification')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_user_tokens_lookup ON user_tokens (token_hash, purpose);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  revoked_at INTEGER,
  user_agent_hash TEXT
);
CREATE INDEX idx_sessions_user_expiry ON sessions (user_id, expires_at);
CREATE INDEX idx_sessions_expiry ON sessions (expires_at);

CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at INTEGER
);
CREATE INDEX idx_api_tokens_token_hash ON api_tokens (token_hash);
CREATE INDEX idx_api_tokens_user_id ON api_tokens (user_id);

CREATE TABLE mastodon_apps (
  instance TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE page_visits (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  path TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_page_visits_user_id ON page_visits (user_id);
CREATE INDEX idx_page_visits_created_at ON page_visits (created_at);

CREATE TABLE auth_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'login_success', 'login_failure', 'logout', 'signup', 'password_change',
    'password_reset_request', 'password_reset_complete', 'account_deleted',
    'email_verified', 'api_token_created', 'api_token_revoked'
  )),
  ip_address TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_auth_events_user_id ON auth_events (user_id);
CREATE INDEX idx_auth_events_created_at ON auth_events (created_at);
CREATE INDEX idx_auth_events_event_type ON auth_events (event_type);

CREATE TABLE product_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_name TEXT NOT NULL,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_product_events_user_id ON product_events (user_id);
CREATE INDEX idx_product_events_created_at ON product_events (created_at);
CREATE INDEX idx_product_events_event_name ON product_events (event_name);

CREATE TABLE billing_events (
  stripe_event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE webhooks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events_json TEXT NOT NULL DEFAULT '["post.published","post.failed"]'
    CHECK (json_valid(events_json)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_delivery_at INTEGER,
  last_delivery_status INTEGER
);
CREATE INDEX idx_webhooks_user_id ON webhooks (user_id);

CREATE TABLE platform_settings (
  platform TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE instance_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE invites (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  note TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE server_errors (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  message TEXT,
  error_type TEXT,
  error_message TEXT,
  stack TEXT,
  method TEXT,
  url TEXT
);
CREATE INDEX idx_server_errors_created_at ON server_errors (created_at);

CREATE TABLE admin_alerts (
  key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  detail TEXT,
  active_since INTEGER NOT NULL,
  notified_at INTEGER,
  resolved_at INTEGER
);

CREATE TABLE email_deliveries (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  mailgun_id TEXT,
  category TEXT NOT NULL,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed')),
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_email_deliveries_status_created ON email_deliveries (status, created_at);

CREATE TRIGGER email_deliveries_set_updated_at
AFTER UPDATE ON email_deliveries
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE email_deliveries SET updated_at = unixepoch() WHERE id = NEW.id;
END;
