CREATE TABLE provider_sessions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  provider TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  external_session_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('hosted-observed', 'hosted-governed')),
  capabilities_json TEXT NOT NULL,
  control_token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN (
    'created', 'starting', 'running', 'stopping', 'completed',
    'failed', 'cancelled', 'interrupted'
  )),
  process_id INTEGER CHECK (process_id IS NULL OR process_id > 0),
  last_error_code TEXT,
  last_error_message TEXT,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX provider_sessions_run_created_idx
  ON provider_sessions(run_id, created_at DESC);

CREATE INDEX provider_sessions_status_updated_idx
  ON provider_sessions(status, updated_at);

CREATE TRIGGER provider_sessions_prevent_delete
BEFORE DELETE ON provider_sessions
BEGIN
  SELECT RAISE(ABORT, 'provider sessions are audit records');
END;

CREATE TRIGGER provider_sessions_protect_identity
BEFORE UPDATE ON provider_sessions
WHEN NEW.id != OLD.id
  OR NEW.run_id != OLD.run_id
  OR NEW.provider != OLD.provider
  OR NEW.adapter_version != OLD.adapter_version
  OR NEW.runtime_version != OLD.runtime_version
  OR NEW.protocol_version != OLD.protocol_version
  OR NEW.mode != OLD.mode
  OR NEW.capabilities_json != OLD.capabilities_json
  OR NEW.control_token_hash != OLD.control_token_hash
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'provider session identity is immutable');
END;

CREATE TRIGGER provider_sessions_validate_transition
BEFORE UPDATE OF status ON provider_sessions
WHEN NOT (
  (OLD.status = 'created' AND NEW.status IN ('starting', 'failed', 'cancelled'))
  OR (OLD.status = 'starting' AND NEW.status IN ('running', 'failed', 'cancelled', 'interrupted'))
  OR (OLD.status = 'running' AND NEW.status IN ('stopping', 'completed', 'failed', 'cancelled', 'interrupted'))
  OR (OLD.status = 'stopping' AND NEW.status IN ('completed', 'failed', 'cancelled', 'interrupted'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid provider session status transition');
END;
