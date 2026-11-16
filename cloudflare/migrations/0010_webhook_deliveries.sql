-- One row per delivery attempt, so the owner can see what was sent and how the
-- endpoint answered. Pruned after 30 days by the maintenance run.
CREATE TABLE webhook_deliveries (
  id INTEGER PRIMARY KEY,
  webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  delivery_key TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  status INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_webhook_deliveries_hook ON webhook_deliveries (webhook_id, id DESC);
CREATE INDEX idx_webhook_deliveries_created ON webhook_deliveries (created_at);
