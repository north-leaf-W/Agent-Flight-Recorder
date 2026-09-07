export const ERROR_CODES = {
  VALIDATION_FAILED: "validation_failed",
  UNAUTHORIZED: "unauthorized",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  RUN_NOT_FOUND: "run_not_found",
  EVENT_NOT_FOUND: "event_not_found",
  INVALID_RUN_TRANSITION: "invalid_run_transition",
  IDEMPOTENCY_CONFLICT: "idempotency_conflict",
  PROTOCOL_VERSION_UNSUPPORTED: "protocol_version_unsupported",
  COLLECTION_GAP: "collection_gap",
  APPROVAL_NOT_FOUND: "approval_not_found",
  APPROVAL_STATE_INVALID: "approval_state_invalid",
  GRANT_INVALID: "grant_invalid",
  GRANT_EXPIRED: "grant_expired",
  GRANT_CONSUMED: "grant_consumed",
  ACTION_DIGEST_MISMATCH: "action_digest_mismatch",
  PROTECTED_EVENT_TYPE: "protected_event_type",
  CHECKPOINT_NOT_FOUND: "checkpoint_not_found",
  CHECKPOINT_INVALID: "checkpoint_invalid",
  REPLAY_NOT_FOUND: "replay_not_found",
  REPLAY_BLOCKED: "replay_blocked",
  INTERNAL_ERROR: "internal_error"
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ApiError = {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  requestId: string;
};

export function apiError(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: Record<string, unknown>
): ApiError {
  return details === undefined
    ? { code, message, requestId }
    : { code, message, requestId, details };
}
