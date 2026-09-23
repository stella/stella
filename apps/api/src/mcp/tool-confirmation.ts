/**
 * Who can confirm a tool call that needs a person's go-ahead.
 *
 * Tools the registry marks as irreversible or outbound (and destructive
 * capabilities behind `invoke_capability`) run only with `confirm: true`,
 * which an interactive client sends after asking the person it acts for. An
 * agent run executes without a person at the tool boundary, so it has no one
 * to ask: those tools are unavailable to it, and the run hands the step back
 * to the user instead. `confirmationUnavailableResult` in `tool-utils.ts` is
 * the refusal both confirmation gates return.
 */
export const TOOL_CONFIRMATION = {
  /** The caller relays the person's confirmation as `confirm: true`. */
  caller: "caller",
  /** No person is available to confirm; confirmation-gated tools refuse. */
  unavailable: "unavailable",
} as const;

export type ToolConfirmation =
  (typeof TOOL_CONFIRMATION)[keyof typeof TOOL_CONFIRMATION];
