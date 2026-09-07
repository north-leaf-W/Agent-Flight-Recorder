CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  request_event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
  action_digest TEXT NOT NULL,
  action_context_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'approved', 'consumed', 'denied', 'expired'
  )),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('R0', 'R1', 'R2', 'R3', 'R4')),
  policy_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  reason_codes_json TEXT NOT NULL,
  request_reason TEXT,
  requested_by_actor_json TEXT NOT NULL,
  decided_by TEXT,
  decision_reason TEXT,
  decision_event_id TEXT REFERENCES events(id),
  grant_id TEXT,
  requested_at TEXT NOT NULL,
  request_expires_at TEXT NOT NULL,
  decided_at TEXT,
  consumed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX approvals_status_created_idx ON approvals(status, requested_at);
CREATE INDEX approvals_run_created_idx ON approvals(run_id, requested_at);

CREATE TABLE execution_grants (
  id TEXT PRIMARY KEY,
  approval_id TEXT UNIQUE REFERENCES approvals(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  action_digest TEXT NOT NULL,
  nonce_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'expired')),
  issued_by TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX execution_grants_status_expires_idx
  ON execution_grants(status, expires_at);

CREATE TRIGGER approvals_prevent_delete
BEFORE DELETE ON approvals
BEGIN
  SELECT RAISE(ABORT, 'approvals are immutable audit records');
END;

CREATE TRIGGER approvals_protect_identity
BEFORE UPDATE ON approvals
WHEN NEW.id != OLD.id
  OR NEW.run_id != OLD.run_id
  OR NEW.request_event_id != OLD.request_event_id
  OR NEW.action_digest != OLD.action_digest
  OR NEW.action_context_json != OLD.action_context_json
  OR NEW.risk_level != OLD.risk_level
  OR NEW.policy_id != OLD.policy_id
  OR NEW.rule_id != OLD.rule_id
  OR NEW.reason_codes_json != OLD.reason_codes_json
  OR NEW.requested_by_actor_json != OLD.requested_by_actor_json
  OR NEW.requested_at != OLD.requested_at
  OR NEW.request_expires_at != OLD.request_expires_at
BEGIN
  SELECT RAISE(ABORT, 'approval request fields are immutable');
END;

CREATE TRIGGER approvals_validate_transition
BEFORE UPDATE OF status ON approvals
WHEN NOT (
  (OLD.status = 'pending' AND NEW.status IN ('approved', 'denied', 'expired'))
  OR (OLD.status = 'approved' AND NEW.status IN ('consumed', 'expired'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid approval status transition');
END;

CREATE TRIGGER execution_grants_prevent_delete
BEFORE DELETE ON execution_grants
BEGIN
  SELECT RAISE(ABORT, 'execution grants are immutable audit records');
END;

CREATE TRIGGER execution_grants_protect_identity
BEFORE UPDATE ON execution_grants
WHEN NEW.id != OLD.id
  OR COALESCE(NEW.approval_id, '') != COALESCE(OLD.approval_id, '')
  OR NEW.run_id != OLD.run_id
  OR NEW.action_digest != OLD.action_digest
  OR NEW.nonce_hash != OLD.nonce_hash
  OR NEW.issued_by != OLD.issued_by
  OR NEW.issued_at != OLD.issued_at
  OR NEW.expires_at != OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'execution grant fields are immutable');
END;

CREATE TRIGGER execution_grants_validate_transition
BEFORE UPDATE OF status ON execution_grants
WHEN NOT (OLD.status = 'active' AND NEW.status IN ('consumed', 'expired'))
BEGIN
  SELECT RAISE(ABORT, 'invalid execution grant status transition');
END;
