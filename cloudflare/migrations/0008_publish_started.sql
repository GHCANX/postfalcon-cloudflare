-- Set (once per delivery lease) immediately before the platform is contacted.
-- A Workflow step that re-runs after being interrupted sees it already set and
-- must not contact the platform a second time.
ALTER TABLE posts ADD COLUMN posting_started_at INTEGER;
