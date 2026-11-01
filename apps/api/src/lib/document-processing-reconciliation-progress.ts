export const RECONCILE_BATCH_SIZE = 100;

/**
 * What one reconciliation phase reports for one tick. `count` is the
 * effect the phase had (runs created, rows recovered, deliveries
 * attempted); `hasMore` is the phase's own answer to "was there more than
 * I could take this tick". The two are independent: a phase can scan a
 * full page and act on none of it, so `count` can never stand in for
 * saturation.
 */
export type ReconciliationPhaseResult = {
  count: number;
  hasMore: boolean;
};

/**
 * A capped selection that came back full stopped at the cap, not at the
 * end of the backlog. Every phase computes this from the rows it selected,
 * beside the `.limit()` that capped them.
 */
export const cappedSelectionHasMore = ({
  limit,
  selected,
}: {
  limit: number;
  selected: number;
}): boolean => selected >= limit;

/**
 * What the latest finished tick said about itself, for a caller that has
 * to explain a hold rather than decide one: which phases reported work
 * left behind, or that the tick never reported at all. `none` until the
 * first tick finishes. Read synchronously, so it describes the last tick
 * that finished, never the one in flight.
 */
export type ReconciliationTickReport<Phase extends string> =
  | { readonly status: "failed" }
  | { readonly status: "none" }
  | {
      readonly status: "reported";
      readonly unfinishedPhases: readonly Phase[];
    };

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
export const createReconciliationProgress = <Phase extends string>() => {
  let unfinished = false;
  let running: Promise<void> | null = null;
  let generation = 0;
  let latestReport: ReconciliationTickReport<Phase> = { status: "none" };
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
    /** The latest finished tick's own account; see the type above. */
    latestTickReport: (): ReconciliationTickReport<Phase> => latestReport,
    /**
     * `tick` resolves with the phases that left work behind. The flag is
     * derived from that list rather than reported beside it, so the
     * verdict and its explanation cannot disagree.
     */
    runTick: async (tick: () => Promise<readonly Phase[]>): Promise<void> => {
      // All three published before the first await, so a caller that
      // arrives during this tick waits for it rather than reading the last
      // one, and one that only overlaps it still sees that it happened.
      unfinished = true;
      generation += 1;
      let finish: () => void = () => undefined;
      running = new Promise<void>((resolve) => {
        finish = resolve;
      });
      // Replaced only once the tick reports, so a rejection records the
      // tick as failed without a catch that would have to rethrow.
      let report: ReconciliationTickReport<Phase> = { status: "failed" };
      try {
        const unfinishedPhases = await tick();
        unfinished = unfinishedPhases.length > 0;
        report = { status: "reported", unfinishedPhases };
      } finally {
        latestReport = report;
        running = null;
        finish();
      }
    },
  };
};
