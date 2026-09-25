/**
 * Every check the chat conversation harness runs, by a stable id. A finding
 * names its oracle, so a failure says which guarantee broke, and the mutation
 * matrix (`apps/api/scripts/chat-mutation-matrix.ts`) names the oracle each
 * mutation must trip. Ids are permanent: retire one rather than reuse it.
 */
export const CHAT_ORACLE = {
  /** Every client-answerable call sits on a message its awaiting turn owns. */
  persistedPendingOwned: "chat.persisted.pending-owned",
  /** A settled turn keeps only the open calls its outcome allows. */
  persistedCallsSettled: "chat.persisted.calls-settled",
  /** Every turn a request starts reaches a settled status once the
   *  request is done. */
  persistedTurnSettles: "chat.persisted.turn-settles",
  /** A messages snapshot on the wire holds each message id and tool call
   *  once, before any client folds it. */
  wireSnapshotIdentity: "chat.wire.snapshot-identity",
  /** (a) The live view holds each message id once. */
  liveMessageIdsUnique: "chat.live.message-ids-unique",
  /** (b) Every interaction the stored thread offers is on screen and
   *  answerable in the live view. */
  liveInteractionsActionable: "chat.live.interactions-actionable",
  /** (c) The live view equals the reload view, under the one documented
   *  normalization. */
  liveEqualsReload: "chat.live.equals-reload",
  /** (d) Every tool call and result appears exactly once, live and reloaded. */
  liveToolPartsOnce: "chat.live.tool-parts-once",
  /** The route accepts every request the web client builds for its own
   *  thread. */
  clientRequestsAccepted: "chat.client.requests-accepted",
  /** The web runtime reports no error. */
  clientNoErrors: "chat.client.no-errors",
  /** Every scripted model run was requested, and no request went unscripted. */
  providerScriptsConsumed: "chat.provider.scripts-consumed",
  /** The cards on screen and the interactions stored are exactly the ones the
   *  conversation's ledger expects. */
  ledgerPending: "chat.ledger.pending",
  /** Every tool call the model made is on screen and reloads, exactly once. */
  ledgerCallsPresent: "chat.ledger.calls-present",
  /** An approved call runs once; a denied or unanswered one never runs. */
  ledgerEffectsAuthorized: "chat.ledger.effects-authorized",
} as const;

export type ChatOracleId = (typeof CHAT_ORACLE)[keyof typeof CHAT_ORACLE];

export type OracleViolation = { detail: unknown; oracle: ChatOracleId };

/** One violation per finding in `findings`. */
export const violationsOf = (
  oracle: ChatOracleId,
  findings: readonly unknown[],
): OracleViolation[] => findings.map((detail) => ({ detail, oracle }));
