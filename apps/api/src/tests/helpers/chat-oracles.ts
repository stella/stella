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
  /** Every chat ref the stored thread shows the model names, in every later
   *  request of the thread, the target it named when first stored; the
   *  thread's name ledger holds every such ref and every stored tool-call
   *  id. */
  persistedRefsStable: "chat.persisted.refs-stable",
  /** A settled turn's status and reason are the outcome its answer stores. */
  persistedTurnOutcome: "chat.persisted.turn-outcome",
  /** A turn that streamed holds the id of the run its request started. */
  persistedRunIdentity: "chat.persisted.run-identity",
  /** A thread an earlier release stored loads on the current code, serves
   *  every message, part and answer it held, and keeps them once continued;
   *  and what the current code stores has a fixture. */
  persistedPastReleaseLoads: "chat.persisted.past-release-loads",
  /** A turn's run does not depend on the request that started it: once the
   *  handler hands its response back, nothing reads the request, and its end
   *  cuts no turn short whose response is read to the end. */
  runOutlivesRequest: "chat.run.outlives-request",
  /** A messages snapshot on the wire holds each message id and tool call
   *  once, before any client folds it. */
  wireSnapshotIdentity: "chat.wire.snapshot-identity",
  /** A messages snapshot on the wire carries a tool result only where the
   *  stored thread holds one: what only the engine was handed never reaches
   *  a client. */
  wireResultsStored: "chat.wire.results-stored",
  /** A messages snapshot carries every message the thread's page serves,
   *  other than one the response writes, exactly as the page serves it. */
  wireSnapshotServed: "chat.wire.snapshot-served",
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
  /** The skills the composer offers in a chat are exactly the ones a send
   *  from that chat runs rather than names unavailable. */
  skillsMenuMatchesSend: "chat.skills.menu-matches-send",
  /** The route accepts every request the web client builds for its own
   *  thread. */
  clientRequestsAccepted: "chat.client.requests-accepted",
  /** The web runtime reports no error. */
  clientNoErrors: "chat.client.no-errors",
  /** Every scripted model run was requested, and no request went unscripted. */
  providerScriptsConsumed: "chat.provider.scripts-consumed",
  /** Every request handed to a provider answers each tool call exactly once,
   *  right after the message making it, with no result for a call it does
   *  not hold; each signed thinking block stays, once and in order, first on
   *  the message holding the calls it was produced with. */
  providerTranscriptSettled: "chat.provider.transcript-settled",
  /** Every model request of a thread begins with the whole prompt of the
   *  one before it: its tools, system prompt and messages, in cache order
   *  (`chat-prompt-prefix.ts`), so the provider's prompt cache holds. */
  providerPrefixStable: "chat.provider.prefix-stable",
  /** Once a turn is over, every later model call of the thread is handed
   *  each of its tool results in the same text: a request
   *  reads the earlier turns as stored, as the next one will. */
  providerResultsStable: "chat.provider.results-stable",
  /** The cards on screen and the interactions stored are exactly the ones the
   *  conversation's ledger expects. */
  ledgerPending: "chat.ledger.pending",
  /** Every tool call the model made is on screen and reloads, exactly once. */
  ledgerCallsPresent: "chat.ledger.calls-present",
  /** An approved call runs once; a denied or unanswered one never runs. */
  ledgerEffectsAuthorized: "chat.ledger.effects-authorized",
  // A settled turn against what its run showed (`chat-turn-outcome.ts`).
  // A turn left running with no terminal event is
  // `chat.persisted.turn-settles`.
  /** A completed turn's run added a visible part (text, a tool call, other
   *  content) to the message it wrote, beyond what that message held. */
  turnCompletedShowsAnswer: "chat.turn.completed-shows-answer",
  /** A turn that failed because its run answered nothing (an empty
   *  completion) settles as `empty-response`, retryable. */
  turnEmptyFailsRetryably: "chat.turn.empty-fails-retryably",
  /** A failed turn stores its failure on its message, and a reload shows
   *  it as an error. */
  turnFailedShowsError: "chat.turn.failed-shows-error",
  /** A response read to its end ends in exactly one run terminal event,
   *  last, which is an error exactly when its turn failed. */
  turnOneTerminal: "chat.turn.one-terminal",
  /** The page that watched a turn shows an error exactly when a reload of
   *  the thread does. */
  turnLiveOutcomeEqualsReload: "chat.turn.live-outcome-equals-reload",
  /** A builder that shows its output beside the chat (a thread title, a
   *  recap, suggested prompts) shows nothing, never a blank, when the model
   *  answers with nothing. */
  surfaceEmptyShowsNothing: "chat.surface.empty-shows-nothing",
  /** Every action the page offers on the live view is one the conversation
   *  model's commands may take there. */
  modelCoversPageActions: "chat.model.covers-page-actions",
  /** A code-mode script that calls a direct tool gets back that tool's name
   *  and the instruction to call it outside the script, never a bare
   *  "not defined" the model reads as a missing tool. */
  codeModeMisplacedCallExplained: "chat.code-mode.misplaced-call-explained",
  // Reported by the web app's rendered replay of recorded conversations
  // (`apps/web/src/components/chat/recorded-conversations.dom.test.tsx`).
  /** The rendered page shows what the stored thread says: open cards,
   *  approval marks, step lists, and nothing busy once idle. */
  renderCardsMatchStored: "chat.render.cards-match-stored",
  /** A second tab loading the thread renders what the live page shows. */
  renderReloadMatchesLive: "chat.render.reload-matches-live",
  /** The rendered page posts exactly the recorded requests. */
  renderRequestsMatchRecorded: "chat.render.requests-match-recorded",
  /** A conversation grant answers each matching approval exactly once. */
  renderGrantAnswersOnce: "chat.render.grant-answers-once",
  // Reported by the web app's streaming commit budget
  // (`apps/web/src/features/chat/stream-chunk-commit-budget.ts`).
  /** While a response streams any kind of chunk in small deltas, the thread
   *  page commits no more often than that kind's budget. */
  renderStreamCommitsBounded: "chat.render.stream-commits-bounded",
  // Reported by the provider wire replay
  // (`apps/api/src/lib/tanstack-ai-provider-wire.test.ts`).
  /** Every provider request went through `fetch` to a provider host and
   *  was answered by the cassette, which it consumed. */
  providerWireTransport: "chat.provider-wire.transport",
  /** An adapter run ends in exactly one terminal event, last, and never
   *  throws. */
  providerWireOneTerminal: "chat.provider-wire.one-terminal",
  /** The run ends the way the wire did: the declared finish reason, or a
   *  run error; a stop reason no answer stands on never reads as one. */
  providerWireFinish: "chat.provider-wire.finish",
  /** The answer's text reaches the text deltas. */
  providerWireText: "chat.provider-wire.text",
  /** Each tool call ends once with input that satisfies the tool's
   *  declared schema. */
  providerWireToolInput: "chat.provider-wire.tool-input",
  /** A finished run reports its token usage, and a failed one the usage the
   *  provider reported before it failed. */
  providerWireUsage: "chat.provider-wire.usage",
  /** A provider failure reaches the run error with its message and
   *  classification. */
  providerWireError: "chat.provider-wire.error",
  /** A cancelled run ends promptly, unfinished, with no further request. */
  providerWireCancel: "chat.provider-wire.cancel",
  /** A body cut into reads anywhere (inside a multi-byte character, a
   *  `data:` line, a CRLF) yields the events the whole body does. */
  providerWireSplit: "chat.provider-wire.split",
  /** Every request the adapter sends is the one its cassette pins: the
   *  protocol headers, and the body with its key order, minus the prompt
   *  text. */
  providerWireRequestShape: "chat.provider-wire.request-shape",
  /** Every request an adapter sends holds to the request schema its
   *  provider publishes and to the provider's documented rules the schema
   *  leaves out (`provider-request-schema.ts`). */
  providerWireRequestRules: "chat.provider-wire.request-rules",
  // Reported by the tool-call end test
  // (`apps/api/src/handlers/chat/tool-call-end-arguments.test.ts`).
  /** A tool call's stored arguments are its normalized input, never the raw
   *  wire string the provider streamed. */
  providerWireToolArguments: "chat.provider-wire.tool-arguments",
} as const;

export type ChatOracleId = (typeof CHAT_ORACLE)[keyof typeof CHAT_ORACLE];

export type OracleViolation = { detail: unknown; oracle: ChatOracleId };

/** One violation per finding in `findings`. */
export const violationsOf = (
  oracle: ChatOracleId,
  findings: readonly unknown[],
): OracleViolation[] => findings.map((detail) => ({ detail, oracle }));
