CREATE TABLE provider_action_requests (
  id TEXT PRIMARY KEY,
  provider_session_id TEXT NOT NULL REFERENCES provider_sessions(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  provider_rpc_id TEXT NOT NULL,
  provider_method TEXT NOT NULL,
  provider_thread_id TEXT,
  provider_turn_id TEXT,
  provider_item_id TEXT,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  request_blob_hash TEXT REFERENCES blobs(hash),
  action_digest TEXT CHECK (action_digest IS NULL OR length(action_digest) = 64),
  action_context_json TEXT,
  approval_id TEXT REFERENCES approvals(id),
  grant_id TEXT REFERENCES execution_grants(id),
  status TEXT NOT NULL CHECK (status IN (
    'evaluating', 'waiting_approval', 'accepted', 'declined', 'rejected', 'expired'
  )),
  response_hash TEXT CHECK (response_hash IS NULL OR length(response_hash) = 64),
  response_blob_hash TEXT REFERENCES blobs(hash),
  decision_reason TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(provider_session_id, provider_rpc_id)
);

CREATE INDEX provider_action_requests_session_created_idx
  ON provider_action_requests(provider_session_id, created_at, id);

CREATE INDEX provider_action_requests_approval_idx
  ON provider_action_requests(approval_id);

CREATE TRIGGER provider_action_requests_prevent_delete
BEFORE DELETE ON provider_action_requests
BEGIN
  SELECT RAISE(ABORT, 'provider action requests are audit records');
END;

CREATE TRIGGER provider_action_requests_protect_identity
BEFORE UPDATE ON provider_action_requests
WHEN NEW.id != OLD.id
  OR NEW.provider_session_id != OLD.provider_session_id
  OR NEW.run_id != OLD.run_id
  OR NEW.provider_rpc_id != OLD.provider_rpc_id
  OR NEW.provider_method != OLD.provider_method
  OR COALESCE(NEW.provider_thread_id, '') != COALESCE(OLD.provider_thread_id, '')
  OR COALESCE(NEW.provider_turn_id, '') != COALESCE(OLD.provider_turn_id, '')
  OR COALESCE(NEW.provider_item_id, '') != COALESCE(OLD.provider_item_id, '')
  OR NEW.request_hash != OLD.request_hash
  OR COALESCE(NEW.request_blob_hash, '') != COALESCE(OLD.request_blob_hash, '')
  OR COALESCE(NEW.action_digest, '') != COALESCE(OLD.action_digest, '')
  OR COALESCE(NEW.action_context_json, '') != COALESCE(OLD.action_context_json, '')
  OR COALESCE(NEW.approval_id, '') != COALESCE(OLD.approval_id, '')
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'provider action request identity is immutable');
END;

CREATE TRIGGER provider_action_requests_validate_transition
BEFORE UPDATE OF status ON provider_action_requests
WHEN NOT (
  (OLD.status = 'evaluating' AND NEW.status IN (
    'waiting_approval', 'accepted', 'declined', 'rejected', 'expired'
  ))
  OR (OLD.status = 'waiting_approval' AND NEW.status IN (
    'accepted', 'declined', 'rejected', 'expired'
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid provider action request status transition');
END;
