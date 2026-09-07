ALTER TABLE runs ADD COLUMN forked_from_event_id TEXT REFERENCES events(id);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  source_event_id TEXT REFERENCES events(id),
  event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
  workspace_root TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  manifest_blob_hash TEXT NOT NULL REFERENCES blobs(hash),
  tracked_diff_blob_hash TEXT REFERENCES blobs(hash),
  untracked_count INTEGER NOT NULL CHECK (untracked_count >= 0),
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  created_at TEXT NOT NULL
);

CREATE INDEX checkpoints_run_created_idx
  ON checkpoints(run_id, created_at DESC);

CREATE TRIGGER checkpoints_prevent_update
BEFORE UPDATE ON checkpoints
BEGIN
  SELECT RAISE(ABORT, 'checkpoints are immutable');
END;

CREATE TRIGGER checkpoints_prevent_delete
BEFORE DELETE ON checkpoints
BEGIN
  SELECT RAISE(ABORT, 'checkpoints are immutable');
END;

CREATE TABLE replays (
  id TEXT PRIMARY KEY,
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
  source_run_id TEXT NOT NULL REFERENCES runs(id),
  source_event_id TEXT REFERENCES events(id),
  target_run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  mode TEXT NOT NULL CHECK (mode IN ('isolated-live')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  worktree_path TEXT NOT NULL,
  command_json TEXT NOT NULL,
  overrides_json TEXT NOT NULL,
  comparison_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX replays_source_run_created_idx
  ON replays(source_run_id, created_at DESC);

CREATE INDEX replays_status_created_idx
  ON replays(status, created_at DESC);

CREATE TRIGGER replays_prevent_delete
BEFORE DELETE ON replays
BEGIN
  SELECT RAISE(ABORT, 'replays are audit records');
END;

CREATE TRIGGER replays_protect_identity
BEFORE UPDATE ON replays
WHEN NEW.id != OLD.id
  OR NEW.checkpoint_id != OLD.checkpoint_id
  OR NEW.source_run_id != OLD.source_run_id
  OR COALESCE(NEW.source_event_id, '') != COALESCE(OLD.source_event_id, '')
  OR NEW.target_run_id != OLD.target_run_id
  OR NEW.mode != OLD.mode
  OR NEW.worktree_path != OLD.worktree_path
  OR NEW.command_json != OLD.command_json
  OR NEW.overrides_json != OLD.overrides_json
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'replay identity fields are immutable');
END;

CREATE TRIGGER replays_validate_transition
BEFORE UPDATE OF status ON replays
WHEN NOT (
  (OLD.status = 'queued' AND NEW.status IN ('running', 'failed'))
  OR (OLD.status = 'running' AND NEW.status IN ('completed', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid replay status transition');
END;
