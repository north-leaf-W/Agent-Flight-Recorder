CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  parent_run_id TEXT REFERENCES runs(id),
  project_path TEXT NOT NULL,
  task TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'created', 'running', 'waiting_approval', 'completed',
    'failed', 'cancelled', 'interrupted'
  )),
  started_at TEXT,
  ended_at TEXT,
  lease_expires_at TEXT,
  last_sequence_no INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence_no >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX runs_status_started_idx ON runs(status, started_at DESC);

CREATE TABLE blobs (
  hash TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  relative_path TEXT NOT NULL UNIQUE,
  redaction_state TEXT NOT NULL DEFAULT 'not_required',
  created_at TEXT NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  idempotency_key TEXT,
  idempotency_fingerprint TEXT,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  previous_hash TEXT,
  envelope_json TEXT NOT NULL,
  UNIQUE (run_id, sequence_no),
  UNIQUE (run_id, idempotency_key)
);

CREATE INDEX events_run_type_recorded_idx
  ON events(run_id, event_type, recorded_at);

CREATE TABLE event_blobs (
  event_id TEXT NOT NULL REFERENCES events(id),
  blob_hash TEXT NOT NULL REFERENCES blobs(hash),
  PRIMARY KEY (event_id, blob_hash)
);

CREATE TRIGGER events_prevent_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_prevent_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

