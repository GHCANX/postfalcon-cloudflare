-- Fixed-window request counters for the sign-in routes. The key is a keyed hash
-- of the client address, never the address itself. Old windows are deleted by
-- the scheduled maintenance run.
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (key, window_start)
) WITHOUT ROWID;

CREATE INDEX idx_rate_limits_window ON rate_limits (window_start);
