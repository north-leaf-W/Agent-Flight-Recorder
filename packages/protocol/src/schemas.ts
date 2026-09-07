import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";

export const EVENT_SCHEMA_VERSION = "1.0-draft" as const;

export const EVENT_TYPES = [
  "run.created",
  "run.status_changed",
  "agent.session_started",
  "agent.turn_started",
  "agent.turn_completed",
  "agent.turn_failed",
  "model.request",
  "model.response",
  "tool.call_requested",
  "tool.call_started",
  "tool.call_completed",
  "tool.call_failed",
  "shell.command_requested",
  "shell.command_completed",
  "file.read",
  "file.write_requested",
  "file.created",
  "file.modified",
  "file.deleted",
  "file.diff_created",
  "policy.evaluated",
  "approval.requested",
  "approval.decided",
  "approval.expired",
  "approval.consumed",
  "security.grant_rejected",
  "snapshot.created",
  "checkpoint.created",
  "replay.started",
  "replay.completed",
  "evidence.attached",
  "artifact.created",
  "collection.gap_detected",
  "system.warning"
] as const;

export const RUN_STATUSES = [
  "created",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted"
] as const;

export const EVENT_STATUSES = [
  "pending",
  "success",
  "error",
  "cancelled",
  "unknown"
] as const;

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "consumed",
  "denied",
  "expired"
] as const;

export const UUID_V7_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
export const SHA256_PATTERN = "^[0-9a-f]{64}$";
export const RFC3339_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$";

const strict = { additionalProperties: false } as const;

export const UuidV7Schema = Type.String({ pattern: UUID_V7_PATTERN });
export const TimestampSchema = Type.String({ pattern: RFC3339_PATTERN });
export const HashSchema = Type.String({ pattern: SHA256_PATTERN });
export const BlobRefSchema = Type.String({ pattern: `^sha256:[0-9a-f]{64}$` });

export const ActorSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal("human"),
      Type.Literal("agent"),
      Type.Literal("model"),
      Type.Literal("tool"),
      Type.Literal("system")
    ]),
    id: Type.String({ minLength: 1, maxLength: 255 }),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    version: Type.Optional(Type.String({ minLength: 1, maxLength: 100 }))
  },
  strict
);

export const RiskSchema = Type.Object(
  {
    level: Type.Union([
      Type.Literal("R0"),
      Type.Literal("R1"),
      Type.Literal("R2"),
      Type.Literal("R3"),
      Type.Literal("R4")
    ]),
    decision: Type.Union([
      Type.Literal("allow"),
      Type.Literal("deny"),
      Type.Literal("ask")
    ]),
    policyId: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    ruleId: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    reasonCodes: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
      maxItems: 100
    })
  },
  strict
);

const EventTypeSchema = Type.Union(EVENT_TYPES.map((value) => Type.Literal(value)));
const EventStatusSchema = Type.Union(EVENT_STATUSES.map((value) => Type.Literal(value)));

const EventIdentityFields = {
  schemaVersion: Type.Literal(EVENT_SCHEMA_VERSION),
  eventId: UuidV7Schema,
  runId: UuidV7Schema,
  stepId: Type.Optional(UuidV7Schema),
  parentEventId: Type.Optional(UuidV7Schema),
  traceId: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  spanId: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  occurredAt: TimestampSchema,
  actor: ActorSchema,
  eventType: EventTypeSchema,
  status: EventStatusSchema,
  payload: Type.Record(Type.String(), Type.Unknown()),
  risk: Type.Optional(RiskSchema),
  blobRefs: Type.Optional(Type.Array(BlobRefSchema, { maxItems: 1000 })),
  evidenceRefs: Type.Optional(Type.Array(UuidV7Schema, { maxItems: 1000 })),
  snapshotBefore: Type.Optional(UuidV7Schema),
  snapshotAfter: Type.Optional(UuidV7Schema)
};

export const IncomingEventSchema = Type.Object(EventIdentityFields, strict);

export const EventEnvelopeSchema = Type.Object(
  {
    ...EventIdentityFields,
    sequenceNo: Type.Integer({ minimum: 1 }),
    recordedAt: TimestampSchema,
    contentHash: HashSchema,
    previousEventHash: Type.Optional(HashSchema)
  },
  strict
);

export const ActionContextSchema = Type.Object(
  {
    runId: UuidV7Schema,
    actor: Type.Object(
      {
        id: Type.String({ minLength: 1, maxLength: 255 }),
        type: Type.String({ minLength: 1, maxLength: 100 })
      },
      strict
    ),
    tool: Type.String({ minLength: 1, maxLength: 255 }),
    action: Type.String({ minLength: 1, maxLength: 255 }),
    argv: Type.Optional(Type.Array(Type.String(), { maxItems: 10_000 })),
    cwd: Type.Optional(Type.String({ minLength: 1 })),
    targets: Type.Array(
      Type.Object(
        {
          type: Type.String({ minLength: 1, maxLength: 100 }),
          canonicalId: Type.String({ minLength: 1 })
        },
        strict
      ),
      { maxItems: 10_000 }
    ),
    environment: Type.Union([
      Type.Literal("local"),
      Type.Literal("ci"),
      Type.Literal("staging"),
      Type.Literal("production")
    ]),
    sideEffect: Type.Union([
      Type.Literal("none"),
      Type.Literal("local-write"),
      Type.Literal("external-write"),
      Type.Literal("irreversible")
    ]),
    recoverability: Type.Union([
      Type.Literal("easy"),
      Type.Literal("partial"),
      Type.Literal("none")
    ]),
    contentHash: Type.Optional(HashSchema),
    estimatedImpact: Type.Optional(Type.Record(Type.String(), Type.Number()))
  },
  strict
);

export type Actor = Static<typeof ActorSchema>;
export type Risk = Static<typeof RiskSchema>;
export type IncomingEvent = Static<typeof IncomingEventSchema>;
export type EventEnvelope = Static<typeof EventEnvelopeSchema>;
export type ActionContext = Static<typeof ActionContextSchema>;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export type EventType = (typeof EVENT_TYPES)[number];
export type EventStatus = (typeof EVENT_STATUSES)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];

export type ValidationIssue = {
  path: string;
  message: string;
};

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

export function createValidator<T extends TSchema>(schema: T) {
  const validator = TypeCompiler.Compile(schema);

  return (value: unknown): ValidationResult<Static<T>> => {
    if (validator.Check(value)) {
      return { ok: true, value: value as Static<T> };
    }

    return {
      ok: false,
      issues: [...validator.Errors(value)].map((error) => ({
        path: error.path || "/",
        message: error.message
      }))
    };
  };
}

export const validateIncomingEvent = createValidator(IncomingEventSchema);
export const validateEventEnvelope = createValidator(EventEnvelopeSchema);
export const validateActionContext = createValidator(ActionContextSchema);
