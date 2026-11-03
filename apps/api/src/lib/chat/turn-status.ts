export const CHAT_TURN_STATUSES = [
  "accepted",
  "running",
  "awaiting-user",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type ChatTurnStatus = (typeof CHAT_TURN_STATUSES)[number];

export const CHAT_TURN_TIMING_DISPOSITION = {
  accepted: "hidden",
  running: "running",
  "awaiting-user": "finished",
  completed: "finished",
  failed: "finished",
  cancelled: "finished",
  interrupted: "finished",
} as const satisfies Record<ChatTurnStatus, "hidden" | "running" | "finished">;

export const CHAT_TURN_TIMING_ACTIVE_STATUSES = CHAT_TURN_STATUSES.filter(
  (status) => CHAT_TURN_TIMING_DISPOSITION[status] !== "finished",
);

/**
 * Whether a turn in this status still holds the run on the member's computer
 * it reads. A turn holds its run while it runs and while it waits on an
 * answer the run can still take; every other status ends the run.
 */
const CHAT_TURN_HOLDS_LOCAL_RUN = {
  accepted: true,
  running: true,
  "awaiting-user": true,
  completed: false,
  failed: false,
  cancelled: false,
  interrupted: false,
} as const satisfies Record<ChatTurnStatus, boolean>;

/** Statuses of a turn that no longer holds its run; see above. */
export const CHAT_TURN_RUN_ENDING_STATUSES = CHAT_TURN_STATUSES.filter(
  (status) => !CHAT_TURN_HOLDS_LOCAL_RUN[status],
);
