export type PipelineRun = object;

export const createPipelineRunRegistry = () => {
  const activeRuns = new Map<string, PipelineRun>();
  const cancelledRuns = new WeakSet<PipelineRun>();

  return {
    start(key: string): PipelineRun {
      const run = {};
      const previousRun = activeRuns.get(key);
      if (previousRun !== undefined) {
        cancelledRuns.add(previousRun);
      }
      activeRuns.set(key, run);
      return run;
    },
    cancel(key: string): void {
      const activeRun = activeRuns.get(key);
      if (activeRun === undefined) {
        return;
      }
      cancelledRuns.add(activeRun);
      activeRuns.delete(key);
    },
    canCommit(key: string, run: PipelineRun): boolean {
      return activeRuns.get(key) === run && !cancelledRuns.has(run);
    },
    finish(key: string, run: PipelineRun): boolean {
      if (activeRuns.get(key) !== run) {
        return false;
      }
      activeRuns.delete(key);
      return true;
    },
  };
};
