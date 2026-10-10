export const CHAT_TURN_FAILURE_CODES = [
  "boundary-refusal",
  "connector-discovery",
  "empty-response",
  "internal",
  "persistence",
  "provider-error",
  "unsupported-input",
] as const;
export type ChatTurnFailureCode = (typeof CHAT_TURN_FAILURE_CODES)[number];

export const CHAT_TURN_INTERRUPTION_REASONS = [
  "client-disconnected",
  // The turn's owner stopped producing: its lease expired, or its process
  // shut down.
  "owner-lost",
  "timeout",
] as const;
export type ChatTurnInterruptionReason =
  (typeof CHAT_TURN_INTERRUPTION_REASONS)[number];
