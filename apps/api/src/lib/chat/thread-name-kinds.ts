/**
 * The kinds of name a chat thread's ledger (`chat_thread_names`) records:
 * names one request minted that later requests of the thread must read the
 * same way.
 */
export const CHAT_THREAD_NAME_KIND = {
  /** A chat ref shown to the model, with the target it names. */
  refBinding: "ref-binding",
  /** A chat ref spelling shown before bindings existed: its target is
   *  unknown, so it resolves to nothing and is never minted again. */
  retiredRef: "retired-ref",
  /** A tool-call id the thread's stored messages hold. */
  toolCallId: "tool-call-id",
  /** The ledger holds every name of the thread's history from here on; a
   *  thread without it derives its names from its stored messages. */
  ledgerStart: "ledger-start",
} as const;

export type ChatThreadNameKind =
  (typeof CHAT_THREAD_NAME_KIND)[keyof typeof CHAT_THREAD_NAME_KIND];

export const CHAT_THREAD_NAME_KINDS: readonly ChatThreadNameKind[] =
  Object.values(CHAT_THREAD_NAME_KIND);
