CREATE TABLE patch_promotions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  hosted_workspace_id TEXT NOT NULL UNIQUE REFERENCES hosted_workspaces(id),
  approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id),
  action_digest TEXT NOT NULL CHECK (length(action_digest) = 64),
  action_context_json TEXT NOT NULL,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64),
  plan_blob_hash TEXT NOT NULL REFERENCES blobs(hash),
  selected_paths_json TEXT NOT NULL,
  source_fingerprint_before TEXT NOT NULL CHECK (length(source_fingerprint_before) = 64),
  worktree_fingerprint_before TEXT NOT NULL CHECK (length(worktree_fingerprint_before) = 64),
  status TEXT NOT NULL CHECK (status IN (
    'waiting_approval', 'applying', 'completed', 'denied', 'failed'
  )),
  result_source_fingerprint TEXT CHECK (
    result_source_fingerprint IS NULL OR length(result_source_fingerprint) = 64
  ),
  error_code TEXT,
  error_message TEXT,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX patch_promotions_run_requested_idx
  ON patch_promotions(run_id, requested_at DESC);

CREATE INDEX patch_promotions_status_updated_idx
  ON patch_promotions(status, updated_at);

CREATE TRIGGER patch_promotions_prevent_delete
BEFORE DELETE ON patch_promotions
BEGIN
  SELECT RAISE(ABORT, 'patch promotions are audit records');
END;

CREATE TRIGGER patch_promotions_protect_identity
BEFORE UPDATE ON patch_promotions
WHEN NEW.id != OLD.id
  OR NEW.run_id != OLD.run_id
  OR NEW.hosted_workspace_id != OLD.hosted_workspace_id
  OR NEW.approval_id != OLD.approval_id
  OR NEW.action_digest != OLD.action_digest
  OR NEW.action_context_json != OLD.action_context_json
  OR NEW.plan_hash != OLD.plan_hash
  OR NEW.plan_blob_hash != OLD.plan_blob_hash
  OR NEW.selected_paths_json != OLD.selected_paths_json
  OR NEW.source_fingerprint_before != OLD.source_fingerprint_before
  OR NEW.worktree_fingerprint_before != OLD.worktree_fingerprint_before
  OR NEW.requested_at != OLD.requested_at
BEGIN
  SELECT RAISE(ABORT, 'patch promotion identity is immutable');
END;

CREATE TRIGGER patch_promotions_validate_transition
BEFORE UPDATE OF status ON patch_promotions
WHEN NOT (
  (OLD.status = 'waiting_approval' AND NEW.status IN ('applying', 'denied', 'failed'))
  OR (OLD.status = 'applying' AND NEW.status IN ('completed', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid patch promotion status transition');
END;
