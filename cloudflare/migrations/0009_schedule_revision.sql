-- Bumped whenever a post's time or status is changed by the user. It is part of
-- the delivery Workflow instance id and of the claim, so an instance created for
-- an earlier schedule can never publish (or be reused for) a later one.
ALTER TABLE posts ADD COLUMN schedule_revision INTEGER NOT NULL DEFAULT 0;
