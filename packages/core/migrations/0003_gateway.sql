CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
  kind TEXT NOT NULL CHECK (kind IN ('file')),
  path TEXT NOT NULL,
  content_blob_hash TEXT NOT NULL REFERENCES blobs(hash),
  before_hash TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  exact INTEGER NOT NULL CHECK (exact IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX snapshots_run_created_idx ON snapshots(run_id, created_at);

ALTER TABLE approvals ADD COLUMN snapshot_id TEXT REFERENCES snapshots(id);

CREATE TABLE gateway_actions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  approval_id TEXT UNIQUE REFERENCES approvals(id),
  snapshot_id TEXT REFERENCES snapshots(id),
  kind TEXT NOT NULL CHECK (kind IN ('file_delete')),
  action_digest TEXT NOT NULL,
  action_context_json TEXT NOT NULL,
  target_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'waiting_approval', 'executing', 'completed', 'denied', 'failed'
  )),
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  executed_at TEXT,
  error_code TEXT,
  result_event_id TEXT REFERENCES events(id)
);

CREATE INDEX gateway_actions_status_created_idx
  ON gateway_actions(status, requested_at);

CREATE TRIGGER snapshots_prevent_update
BEFORE UPDATE ON snapshots
BEGIN
  SELECT RAISE(ABORT, 'snapshots are immutable');
END;

CREATE TRIGGER snapshots_prevent_delete
BEFORE DELETE ON snapshots
BEGIN
  SELECT RAISE(ABORT, 'snapshots are immutable');
END;

CREATE TRIGGER approvals_protect_snapshot_link
BEFORE UPDATE OF snapshot_id ON approvals
WHEN OLD.snapshot_id IS NOT NULL OR OLD.status != 'pending'
BEGIN
  SELECT RAISE(ABORT, 'approval snapshot link is immutable after assignment');
END;

CREATE TRIGGER gateway_actions_prevent_delete
BEFORE DELETE ON gateway_actions
BEGIN
  SELECT RAISE(ABORT, 'gateway actions are audit records');
END;

CREATE TRIGGER gateway_actions_protect_identity
BEFORE UPDATE ON gateway_actions
WHEN NEW.id != OLD.id
  OR NEW.run_id != OLD.run_id
  OR COALESCE(NEW.approval_id, '') != COALESCE(OLD.approval_id, '')
  OR COALESCE(NEW.snapshot_id, '') != COALESCE(OLD.snapshot_id, '')
  OR NEW.kind != OLD.kind
  OR NEW.action_digest != OLD.action_digest
  OR NEW.action_context_json != OLD.action_context_json
  OR NEW.target_path != OLD.target_path
  OR NEW.requested_at != OLD.requested_at
BEGIN
  SELECT RAISE(ABORT, 'gateway action identity is immutable');
END;

CREATE TRIGGER gateway_actions_validate_transition
BEFORE UPDATE OF status ON gateway_actions
WHEN NOT (
  (OLD.status = 'waiting_approval' AND NEW.status IN ('executing', 'denied', 'failed'))
  OR (OLD.status = 'executing' AND NEW.status IN ('completed', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid gateway action status transition');
END;
