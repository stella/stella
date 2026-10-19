/**
 * Who can confirm a tool call that needs a person's go-ahead.
 *
 * A `caller-confirms` operation (`agent-access.ts`) runs only with
 * `confirm: true`, which an interactive client sends after asking the person
 * it acts for. An agent run executes without a person at the tool boundary,
 * so it has no one to ask: `decideAgentCall` treats those operations as
 * needing a person's approval, and the run hands the step back to the user.
 */
export const TOOL_CONFIRMATION = {
  /** The caller relays the person's confirmation as `confirm: true`. */
  caller: "caller",
  /** No person is available to confirm; confirmation-gated calls refuse. */
  unavailable: "unavailable",
} as const;

export type ToolConfirmation =
  (typeof TOOL_CONFIRMATION)[keyof typeof TOOL_CONFIRMATION];
