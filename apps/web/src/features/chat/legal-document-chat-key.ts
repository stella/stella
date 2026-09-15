/**
 * How every surface addresses the legal document a chat is about.
 *
 * Two corpora now share the one-conversation-per-document rule, so the key
 * names which corpus it came from: a decision and a consolidation that ever
 * shared an id would still be two conversations. Built here rather than
 * concatenated at call sites, so a key is always well formed, always
 * greppable, and a third corpus is one constructor away.
 */

export const LEGAL_DOCUMENT_CHAT_CORPUS = {
  decision: "decision",
  statute: "statute",
} as const;

type LegalDocumentChatCorpus =
  (typeof LEGAL_DOCUMENT_CHAT_CORPUS)[keyof typeof LEGAL_DOCUMENT_CHAT_CORPUS];

export type LegalDocumentChatKey = `${LegalDocumentChatCorpus}:${string}`;

export const decisionChatKey = (decisionId: string): LegalDocumentChatKey =>
  `${LEGAL_DOCUMENT_CHAT_CORPUS.decision}:${decisionId}`;

export const statuteChatKey = (documentId: string): LegalDocumentChatKey =>
  `${LEGAL_DOCUMENT_CHAT_CORPUS.statute}:${documentId}`;

/** A key read back apart again: which corpus, and the document's own id. */
export type ParsedLegalDocumentChatKey = {
  corpus: LegalDocumentChatCorpus;
  id: string;
};

const isLegalDocumentChatCorpus = (
  value: string,
): value is LegalDocumentChatCorpus =>
  Object.hasOwn(LEGAL_DOCUMENT_CHAT_CORPUS, value);

/**
 * The document a key names, or null when the value is not one.
 *
 * Null rather than a panic because the callers sit at trust boundaries: a tab
 * arriving from another window or from storage carries whatever was written
 * there, and a chat bound to no document at all is a valid chat.
 */
export const parseLegalDocumentChatKey = (
  value: unknown,
): ParsedLegalDocumentChatKey | null => {
  if (typeof value !== "string") {
    return null;
  }
  const separator = value.indexOf(":");
  // Without this, `indexOf` returning -1 would slice the last character off
  // instead: "decisions" would read as the decision "decisions".
  if (separator === -1) {
    return null;
  }
  const corpus = value.slice(0, separator);
  const id = value.slice(separator + 1);
  return id === "" || !isLegalDocumentChatCorpus(corpus)
    ? null
    : { corpus, id };
};

/** A stored or broadcast field that is either absent or a well-formed key. */
export const isOptionalLegalDocumentChatKey = (
  value: unknown,
): value is LegalDocumentChatKey | undefined =>
  value === undefined || parseLegalDocumentChatKey(value) !== null;
