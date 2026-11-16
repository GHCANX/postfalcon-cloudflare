-- In-progress chunked uploads (R2 multipart) for files too large for one request.
-- The declared size is reserved against the R2 budget when the upload starts and
-- released if it is aborted or goes stale; on completion it becomes a media_files row.
CREATE TABLE media_uploads (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  upload_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  part_size INTEGER NOT NULL CHECK (part_size > 0),
  parts_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(parts_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_media_uploads_created ON media_uploads (created_at);
