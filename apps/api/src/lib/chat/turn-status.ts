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
