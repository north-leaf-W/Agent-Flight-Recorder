import type { RunStatus } from "./schemas.js";

export const RUN_TRANSITIONS = {
  created: ["running", "waiting_approval", "failed", "cancelled"],
  running: ["waiting_approval", "completed", "failed", "cancelled", "interrupted"],
  waiting_approval: ["running", "failed", "cancelled", "interrupted"],
  interrupted: ["running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: []
} as const satisfies Record<RunStatus, readonly RunStatus[]>;

export const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"] as const;

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return (RUN_TRANSITIONS[from] as readonly RunStatus[]).includes(to);
}

export function isTerminalRunStatus(
  status: RunStatus
): status is (typeof TERMINAL_RUN_STATUSES)[number] {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);
}
