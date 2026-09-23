/**
 * Server writes a review session has in flight, and the order of each
 * suggestion's writes.
 *
 * Starting a new chat thread drops the session from memory. Every write that
 * reconciles into it (a create's id reconcile and replay, an accept, reject or
 * revert and its rollback) has to land first, or its outcome is lost and
 * hydration later resurrects the row. Anything that resets a session, or reads
 * which of its rows are still pending, settles the session's writes first.
 */

import { detached } from "@/lib/detached";
import { LifecycleRegistry } from "@/lib/lifecycle-registry";

type ReviewSessionWrites = {
  inFlight: Set<Promise<void>>;
  /** The latest write per suggestion id; the next write chains after it. */
  suggestionTails: Map<string, Promise<unknown>>;
};

// Entries leave through releaseWhenIdle once a session has nothing pending.
const reviewSessionWrites = new LifecycleRegistry<
  string,
  ReviewSessionWrites
>();

const writesFor = (reviewSessionId: string): ReviewSessionWrites => {
  const existing = reviewSessionWrites.get(reviewSessionId);
  if (existing !== undefined) {
    return existing;
  }
  const created: ReviewSessionWrites = {
    inFlight: new Set(),
    suggestionTails: new Map(),
  };
  reviewSessionWrites.set(reviewSessionId, created);
  return created;
};

const releaseWhenIdle = (
  reviewSessionId: string,
  writes: ReviewSessionWrites,
) => {
  if (
    writes.inFlight.size === 0 &&
    writes.suggestionTails.size === 0 &&
    reviewSessionWrites.get(reviewSessionId) === writes
  ) {
    reviewSessionWrites.delete(reviewSessionId);
  }
};

/**
 * Register a write for a review session, including whatever it reconciles
 * into the session afterwards. Settles like the write, and only after it has
 * left the in-flight set.
 */
export const trackReviewSessionWrite = async (
  reviewSessionId: string,
  write: Promise<void>,
): Promise<void> => {
  const writes = writesFor(reviewSessionId);
  const tracked = write.finally(() => {
    writes.inFlight.delete(tracked);
    releaseWhenIdle(reviewSessionId, writes);
  });
  writes.inFlight.add(tracked);
  await tracked;
};

type SerializeSuggestionWriteOptions<T> = {
  reviewSessionId: string;
  suggestionId: string;
  write: () => Promise<T>;
};

/**
 * Run a suggestion's server write after that suggestion's earlier writes, in
 * submission order. A fast accept then revert could otherwise send the revert
 * first: it would find the row still pending while the accept landed after
 * it, leaving the server accepted and the reviewer looking at pending.
 */
export const serializeSuggestionWrite = async <T>({
  reviewSessionId,
  suggestionId,
  write,
}: SerializeSuggestionWriteOptions<T>): Promise<T> => {
  const writes = writesFor(reviewSessionId);
  const previous =
    writes.suggestionTails.get(suggestionId) ?? Promise.resolve();
  const next = previous.then(
    async () => await write(),
    async () => await write(),
  );
  writes.suggestionTails.set(suggestionId, next);
  const release = () => {
    if (writes.suggestionTails.get(suggestionId) === next) {
      writes.suggestionTails.delete(suggestionId);
      releaseWhenIdle(reviewSessionId, writes);
    }
  };
  detached(
    next.then(release, release),
    "review-session-writes.release-suggestion-tail",
  );
  return await next;
};

/**
 * Wait until a review session has no write in flight, including writes that
 * start while earlier ones settle. A failed write counts as settled: its
 * caller already reconciled the session to the server's state.
 */
export const settleReviewSessionWrites = async (
  reviewSessionId: string,
): Promise<void> => {
  const writes = reviewSessionWrites.get(reviewSessionId);
  if (writes === undefined) {
    return;
  }
  await Promise.allSettled([
    ...writes.inFlight,
    ...writes.suggestionTails.values(),
  ]);
  await settleReviewSessionWrites(reviewSessionId);
};
