-- A single row makes the storage ceiling and monthly operation limits one
-- atomic conditional update. Storage counters persist across month boundaries;
-- only operation counters reset when period_key changes.
CREATE TABLE IF NOT EXISTS r2_budget_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  class_a_operations INTEGER NOT NULL DEFAULT 0 CHECK (class_a_operations >= 0),
  class_b_operations INTEGER NOT NULL DEFAULT 0 CHECK (class_b_operations >= 0),
  media_bytes INTEGER NOT NULL DEFAULT 0 CHECK (media_bytes >= 0),
  total_bytes INTEGER NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
  period_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO r2_budget_state (singleton, period_key)
VALUES (1, strftime('%Y-%m', 'now'));
