/**
 * In-flight persistence of queued DOCX suggestions, per review session.
 *
 * A background create reconciles server ids into the review session and then
 * replays any resolution the reviewer already made. Both steps need the
 * session to exist: a reset that lands first leaves the server rows pending,
 * and hydration brings them back. Anything that resets a session, or reads
 * which of its rows are persisted, settles the in-flight persists first.
 */

const inFlightPersists = new Map<string, Set<Promise<void>>>();

/**
 * Register a persist for a review session. Settles like the persist, and only
 * after it has left the in-flight set.
 */
export const trackDocxSuggestionPersist = async (
  reviewSessionId: string,
  persist: Promise<void>,
): Promise<void> => {
  const persists = inFlightPersists.get(reviewSessionId) ?? new Set();
  inFlightPersists.set(reviewSessionId, persists);
  const tracked = persist.finally(() => {
    persists.delete(tracked);
    if (persists.size === 0) {
      inFlightPersists.delete(reviewSessionId);
    }
  });
  persists.add(tracked);
  await tracked;
};

/**
 * Wait until no persist is in flight for a review session, including any that
 * start while earlier ones settle. A failed persist counts as settled: its
 * rows stay unpersisted and never reached the server.
 */
export const settleDocxSuggestionPersists = async (
  reviewSessionId: string,
): Promise<void> => {
  const persists = inFlightPersists.get(reviewSessionId);
  if (persists === undefined) {
    return;
  }
  await Promise.allSettled(persists);
  await settleDocxSuggestionPersists(reviewSessionId);
};
