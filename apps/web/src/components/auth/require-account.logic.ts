import type { ClientAuthStatus } from "@/hooks/use-client-auth-status";

/**
 * What the gate answered.
 *
 * `checking` is its own answer rather than a second `ask`: the session read
 * has not come back yet, so the reader is not known to be a visitor and must
 * not be asked to sign in as though they were one. A press in that window
 * does nothing, the way the public sidebar's own controls stay inert.
 */
export const ACCOUNT_GATE_OUTCOME = {
  allowed: "allowed",
  asking: "asking",
  checking: "checking",
} as const;

export type AccountGateOutcome =
  (typeof ACCOUNT_GATE_OUTCOME)[keyof typeof ACCOUNT_GATE_OUTCOME];

/**
 * What the gate answers for each state of the session read. Total over that
 * union, so a state added later has to decide rather than falling into
 * `asking` and telling a member they have no account.
 */
export const ACCOUNT_GATE_FOR_SESSION = {
  anonymous: ACCOUNT_GATE_OUTCOME.asking,
  authenticated: ACCOUNT_GATE_OUTCOME.allowed,
  checking: ACCOUNT_GATE_OUTCOME.checking,
  // The session read failed and will not settle by waiting; signing in is
  // the one way to re-establish it, and nothing is filed without identity.
  unavailable: ACCOUNT_GATE_OUTCOME.asking,
} as const satisfies Record<ClientAuthStatus["status"], AccountGateOutcome>;
