CREATE TABLE hosted_workspaces (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
  source_workspace_root TEXT NOT NULL,
  worktree_path TEXT NOT NULL UNIQUE,
  base_commit TEXT NOT NULL,
  source_fingerprint_before TEXT NOT NULL,
  source_fingerprint_after TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'preparing', 'ready', 'active', 'finalized', 'failed', 'cleaned'
  )),
  changed_paths_json TEXT NOT NULL DEFAULT '[]',
  diff_blob_hash TEXT REFERENCES blobs(hash),
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  ready_at TEXT,
  finalized_at TEXT,
  cleaned_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX hosted_workspaces_status_updated_idx
  ON hosted_workspaces(status, updated_at);

CREATE TRIGGER hosted_workspaces_prevent_delete
BEFORE DELETE ON hosted_workspaces
BEGIN
  SELECT RAISE(ABORT, 'hosted workspaces are audit records');
END;

CREATE TRIGGER hosted_workspaces_protect_identity
BEFORE UPDATE ON hosted_workspaces
WHEN NEW.id != OLD.id
  OR NEW.run_id != OLD.run_id
  OR NEW.checkpoint_id != OLD.checkpoint_id
  OR NEW.source_workspace_root != OLD.source_workspace_root
  OR NEW.worktree_path != OLD.worktree_path
  OR NEW.base_commit != OLD.base_commit
  OR NEW.source_fingerprint_before != OLD.source_fingerprint_before
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'hosted workspace identity is immutable');
END;

CREATE TRIGGER hosted_workspaces_validate_transition
BEFORE UPDATE OF status ON hosted_workspaces
WHEN NOT (
  (OLD.status = 'preparing' AND NEW.status IN ('ready', 'failed'))
  OR (OLD.status = 'ready' AND NEW.status IN ('active', 'finalized', 'failed'))
  OR (OLD.status = 'active' AND NEW.status IN ('finalized', 'failed'))
  OR (OLD.status IN ('finalized', 'failed') AND NEW.status = 'cleaned')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid hosted workspace status transition');
END;

CREATE TABLE provider_events (
  id TEXT PRIMARY KEY,
  provider_session_id TEXT NOT NULL REFERENCES provider_sessions(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  arrival_sequence INTEGER NOT NULL CHECK (arrival_sequence > 0),
  provider_method TEXT NOT NULL,
  provider_event_id TEXT,
  provider_thread_id TEXT,
  provider_turn_id TEXT,
  provider_item_id TEXT,
  raw_hash TEXT NOT NULL CHECK (length(raw_hash) = 64),
  raw_blob_hash TEXT REFERENCES blobs(hash),
  normalized_event_id TEXT REFERENCES events(id),
  parse_status TEXT NOT NULL CHECK (parse_status IN ('mapped', 'ignored', 'gap', 'invalid')),
  gap_reason TEXT,
  received_at TEXT NOT NULL,
  UNIQUE(provider_session_id, arrival_sequence)
);

CREATE INDEX provider_events_run_arrival_idx
  ON provider_events(run_id, provider_session_id, arrival_sequence);

CREATE INDEX provider_events_normalized_event_idx
  ON provider_events(normalized_event_id);

CREATE TRIGGER provider_events_prevent_update
BEFORE UPDATE ON provider_events
BEGIN
  SELECT RAISE(ABORT, 'provider events are append-only');
END;

CREATE TRIGGER provider_events_prevent_delete
BEFORE DELETE ON provider_events
BEGIN
  SELECT RAISE(ABORT, 'provider events are audit records');
END;

CREATE TABLE run_coverage (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  provider_session_id TEXT REFERENCES provider_sessions(id),
  provider_event_count INTEGER NOT NULL CHECK (provider_event_count >= 0),
  normalized_event_count INTEGER NOT NULL CHECK (normalized_event_count >= 0),
  ignored_event_count INTEGER NOT NULL CHECK (ignored_event_count >= 0),
  gap_count INTEGER NOT NULL CHECK (gap_count >= 0),
  unknown_event_count INTEGER NOT NULL CHECK (unknown_event_count >= 0),
  invalid_event_count INTEGER NOT NULL CHECK (invalid_event_count >= 0),
  coverage_percent REAL NOT NULL CHECK (coverage_percent >= 0 AND coverage_percent <= 100),
  coverage_level TEXT NOT NULL CHECK (coverage_level IN ('L0', 'L1', 'L2', 'L3')),
  summary_json TEXT NOT NULL,
  calculated_at TEXT NOT NULL
);
