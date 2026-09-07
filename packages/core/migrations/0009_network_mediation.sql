CREATE TABLE network_mediation_records (
  id TEXT PRIMARY KEY,
  provider_session_id TEXT NOT NULL REFERENCES provider_sessions(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  source TEXT NOT NULL CHECK (source IN ('host', 'provider', 'runtime', 'observer')),
  operation TEXT NOT NULL CHECK (length(operation) > 0),
  decision TEXT NOT NULL CHECK (decision IN (
    'control-allowed', 'sandbox-enforced', 'denied', 'observed', 'degraded'
  )),
  requested_policy_json TEXT,
  effective_policy_json TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(provider_session_id, sequence_no)
);

CREATE INDEX network_mediation_run_created_idx
  ON network_mediation_records(run_id, created_at, id);

CREATE INDEX network_mediation_session_sequence_idx
  ON network_mediation_records(provider_session_id, sequence_no);

CREATE TRIGGER network_mediation_records_prevent_update
BEFORE UPDATE ON network_mediation_records
BEGIN
  SELECT RAISE(ABORT, 'network mediation records are immutable');
END;

CREATE TRIGGER network_mediation_records_prevent_delete
BEFORE DELETE ON network_mediation_records
BEGIN
  SELECT RAISE(ABORT, 'network mediation records are audit records');
END;
