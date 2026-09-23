import type { ClientAuthStatus } from "@/hooks/use-client-auth-status";
import type { TranslationKey } from "@/i18n/types";

/**
 * What the visitor was about to create when the gate opened, and the line the
 * dialog leads with. The map is the source of truth and the union is read off
 * it, so a new gated act cannot be added without choosing its wording.
 *
 * Every member names an act that would reach an AI endpoint. Reading what is
 * already there — a published headnote, an answer an organization already
 * paid for — is not one of them and is never gated.
 */
export const ACCOUNT_INTENT_TITLE_KEYS = {
  askAboutDocument: "auth.requireAccount.askAboutDocument",
  askInChat: "auth.requireAccount.askInChat",
  generateHeadnotes: "auth.requireAccount.generateHeadnotes",
  refineSearch: "auth.requireAccount.refineSearch",
  writeResearchQuestion: "auth.requireAccount.writeResearchQuestion",
} as const satisfies Record<string, TranslationKey>;

export type AccountIntent = keyof typeof ACCOUNT_INTENT_TITLE_KEYS;

/**
 * What the gate answered.
 *
 * `checking` is its own answer rather than a second `ask`: the session read
 * has not come back yet, so the reader is not known to be a visitor and must
 * not be shown a dialog telling them they are one. A press in that window
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
} as const satisfies Record<ClientAuthStatus["status"], AccountGateOutcome>;
