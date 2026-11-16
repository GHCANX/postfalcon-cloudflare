-- Cloudflare-only schema. PostgreSQL migrations remain authoritative for the
-- Docker path until the documented D1 data migration is rehearsed.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS worker_job_runs (
  id INTEGER PRIMARY KEY,
  job_name TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_worker_job_runs_job_started
  ON worker_job_runs (job_name, started_at DESC);

CREATE TABLE IF NOT EXISTS usage_counters (
  period_key TEXT NOT NULL,
  counter_name TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (period_key, counter_name)
);

CREATE TABLE IF NOT EXISTS app_metadata (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
