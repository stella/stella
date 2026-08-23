/**
 * Reconciliation progress as the idle sampler sees it. A caller that
 * arrives while a tick is running waits for that tick instead of reading
 * the previous one's answer, which makes the answer independent of how
 * the caller's cadence lines up with the reconciliation cadence: a
 * snapshot read would let a sampler that keeps landing inside slow ticks
 * see "running" at every sample and never let the worker exit, while
 * still risking a stale drained answer from the tick before. The flag
 * clears only when a tick resolves fully drained; a rejected tick leaves
 * it set, because a tick that never reported cannot prove the backlog is
 * empty. One tick at a time: the caller serialises them.
 */
export const createReconciliationProgress = () => {
  let unfinished = false;
  let running: Promise<void> | null = null;
  let generation = 0;
  return {
    hasUnfinishedWork: async (): Promise<boolean> => {
      await running;
      return unfinished;
    },
    /**
     * Whether a tick is running right now, for a caller that has already
     * taken its other readings and is deciding in this frame: the awaited
     * answer above can only describe the tick it waited for, so a tick
     * that started afterwards is visible here and nowhere else.
     */
    isTickRunning: (): boolean => running !== null,
    /**
     * How many ticks have started. A caller that snapshots this and
     * re-reads it before deciding sees any tick that began in between,
     * including one that also finished there and so left neither a
     * running flag nor a verdict of its own behind.
     */
    tickGeneration: (): number => generation,
    /** `tick` resolves with whether it left work behind. */
    runTick: async (tick: () => Promise<boolean>): Promise<void> => {
      // All three published before the first await, so a caller that
      // arrives during this tick waits for it rather than reading the last
      // one, and one that only overlaps it still sees that it happened.
      unfinished = true;
      generation += 1;
      let finish: () => void = () => undefined;
      running = new Promise<void>((resolve) => {
        finish = resolve;
      });
      try {
        unfinished = await tick();
      } finally {
        running = null;
        finish();
      }
    },
  };
};
