-- One row per stored R2 object. Posts reference an object through
-- post_media.media_file_id, so several posts (cross-posts, recurring copies)
-- can share a single object; it is deleted only once nothing references it.
CREATE TABLE media_files (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_media_files_user ON media_files (user_id);

ALTER TABLE post_media ADD COLUMN media_file_id INTEGER REFERENCES media_files(id);
CREATE INDEX idx_post_media_file ON post_media (media_file_id) WHERE media_file_id IS NOT NULL;
