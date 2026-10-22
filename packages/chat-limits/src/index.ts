// Size limit for a single chat context-file attachment. Shared between the
// client (drag/drop + file-picker validation) and the server (attachment
// validation) so the two ends can never drift apart.
//
// The megabytes value is the source; the server derives its human-readable
// Elysia limit ("10m") and byte budget from it, and the client validates
// selected files against the byte budget.

/** Max chat context-file attachment size, in whole megabytes. */
export const CHAT_CONTEXT_FILE_MAX_MEGABYTES = 10;

/** Max chat context-file attachment size, in bytes. */
export const CHAT_CONTEXT_FILE_MAX_BYTES =
  CHAT_CONTEXT_FILE_MAX_MEGABYTES * 1024 * 1024;

/**
 * How much one assistant turn may do on its own between two messages from the
 * user: the tool calls it runs, and the prompt tokens its model calls read.
 * Every grant mode (ask, allow in conversation, always allow), model,
 * provider and run mode shares it. A turn that reaches either cap pauses, and
 * only the user's next message (the paused turn's Continue included) opens a
 * new window.
 *
 * 50 tool calls is half the agent loop's own iteration ceiling and over ten
 * times the largest turn the recorded conversations hold (4 calls). 4M prompt
 * tokens is twenty model calls at the largest prompt compaction lets a call
 * reach (200k); a turn of 72k-token calls reaches the tool-call cap first.
 */
export const CHAT_TURN_BUDGET = {
  maxToolCalls: 50,
  maxPromptTokens: 4_000_000,
} as const satisfies ChatTurnBudget;

export type ChatTurnBudget = {
  /** Tool calls the turn may run. */
  maxToolCalls: number;
  /** Prompt tokens its model calls may read, summed over every call. */
  maxPromptTokens: number;
};

/** Which cap of `CHAT_TURN_BUDGET` a paused turn reached. */
export const CHAT_TURN_PAUSE_REASONS = ["tool-calls", "prompt-tokens"] as const;
export type ChatTurnPauseReason = (typeof CHAT_TURN_PAUSE_REASONS)[number];
