CREATE TABLE post_delivery_attempts (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  workflow_instance_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('claimed', 'published', 'failed', 'review_required', 'skipped')),
  detail TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_post_delivery_attempts_post_created
  ON post_delivery_attempts (post_id, created_at DESC);
