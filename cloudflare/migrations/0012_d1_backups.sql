-- One row per D1 export kept in R2 under backups/. byte_size is what was
-- reserved against the R2 total-storage budget, released when the copy is pruned.
CREATE TABLE d1_backups (
  id INTEGER PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_d1_backups_created ON d1_backups (created_at DESC);
