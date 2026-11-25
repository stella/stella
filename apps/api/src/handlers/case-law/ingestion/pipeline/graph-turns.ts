/**
 * Admits a decision's citation graph transaction. The graph lock is one
 * global lock, so of the decisions a batch writes at once only one can hold
 * it; the others would sit on a pooled connection waiting for it, leaving
 * fewer connections for the work that does run concurrently (identity
 * reads, policy reads, settlement). Taking turns in the process first keeps
 * at most one of the batch's connections in the graph queue.
 */
export type GraphTurn = <T>(write: () => Promise<T>) => Promise<T>;

/** A decision written on its own: nothing of its own to wait for. */
export const takeGraphTurnAlone: GraphTurn = async (write) => await write();

/** Turns in arrival order, one at a time, for the decisions of one batch. */
export const createGraphTurns = (): GraphTurn => {
  let previous: Promise<void> = Promise.resolve();
  return async (write) => {
    const before = previous;
    const turn = Promise.withResolvers<undefined>();
    previous = turn.promise;
    await before;
    try {
      return await write();
    } finally {
      turn.resolve(undefined);
    }
  };
};
