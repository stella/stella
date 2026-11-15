export const CHAT_TURN_STATUSES = [
  "accepted",
  "running",
  "awaiting-user",
  "handed-over",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type ChatTurnStatus = (typeof CHAT_TURN_STATUSES)[number];

/**
 * The statuses of a turn not yet settled; a thread holds at most one.
 * `handed-over`: the API task that read the turn's local run stopped and
 * released it at an event boundary, with the answer so far stored; another
 * task adopts it and reads the run on. Nobody owns it until then, and it
 * ends `owner-lost` when nobody adopts it by its lease.
 */
export const ACTIVE_CHAT_TURN_STATUSES = [
  "accepted",
  "running",
  "awaiting-user",
  "handed-over",
] as const satisfies readonly ChatTurnStatus[];

export const CHAT_TURN_TIMING_DISPOSITION = {
  accepted: "hidden",
  running: "running",
  "awaiting-user": "finished",
  // Still active time for the member: the run goes on on the computer.
  "handed-over": "running",
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
  // Released for another task to adopt; the run goes on meanwhile.
  "handed-over": true,
  completed: false,
  failed: false,
  cancelled: false,
  interrupted: false,
} as const satisfies Record<ChatTurnStatus, boolean>;

/** Statuses of a turn that no longer holds its run; see above. */
export const CHAT_TURN_RUN_ENDING_STATUSES = CHAT_TURN_STATUSES.filter(
  (status) => !CHAT_TURN_HOLDS_LOCAL_RUN[status],
);

/**
 * Whether a turn in this status is still being written to its chat run log,
 * so a viewer that joins it tails the log. A handed-over turn's log stays
 * open for the task that adopts it, so a viewer tails it through the gap.
 */
export const CHAT_TURN_LOG_IS_LIVE = {
  accepted: false,
  running: true,
  "awaiting-user": false,
  "handed-over": true,
  completed: false,
  failed: false,
  cancelled: false,
  interrupted: false,
} as const satisfies Record<ChatTurnStatus, boolean>;
