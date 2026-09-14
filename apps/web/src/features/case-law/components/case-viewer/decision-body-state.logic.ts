/**
 * Why a decision is on screen without its text.
 *
 * The read reports its cases separately because they are different answers
 * to the reader: a failed object read is retryable, a document nobody has
 * fetched yet resolves on its own, and a publisher that offers no text never
 * will. Collapsing them into "no text" is what leaves the pane blank.
 */
export const MISSING_BODY_REASON = {
  /** Nothing to fetch: the source record carries no document. */
  absent: "absent",
  /** Queued: the read-through has not brought the document in yet. */
  pending: "pending",
  /** The stored document could not be read. */
  readFailed: "readFailed",
  /** The publisher offers no text for this decision. */
  unavailable: "unavailable",
} as const;

export type MissingBodyReason =
  (typeof MISSING_BODY_REASON)[keyof typeof MISSING_BODY_REASON];

/** The read's own account of the document, as the decision endpoint ships it. */
export type DecisionDocumentState = {
  documentPending: boolean;
  documentReadFailed: boolean;
  documentUnavailable: boolean;
};

export const missingBodyReason = ({
  documentPending,
  documentReadFailed,
  documentUnavailable,
}: DecisionDocumentState): MissingBodyReason => {
  // Ahead of the other flags: with the payload refused, nothing else can
  // tell a failed read apart from a decision that never had a document.
  if (documentReadFailed) {
    return MISSING_BODY_REASON.readFailed;
  }

  if (documentPending) {
    return MISSING_BODY_REASON.pending;
  }

  return documentUnavailable
    ? MISSING_BODY_REASON.unavailable
    : MISSING_BODY_REASON.absent;
};

/** Whether asking again can still produce the text. */
export const missingBodyRetryable = (reason: MissingBodyReason): boolean =>
  reason === MISSING_BODY_REASON.readFailed ||
  reason === MISSING_BODY_REASON.pending;
