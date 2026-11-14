type BudgetMetadata = {
  surface: "scheduled-job" | "statement";
  reason: string;
  /**
   * Set only while a measured statement or job is over its budget and a change to
   * bring it under is in progress. The gate then requires the measurement to
   * stay above the budget, so the entry is removed as soon as it passes.
   */
  overBudget?: { reason: string };
  /** Per-statement database deadline for a scheduled job. */
  statementDeadlineMs?: number;
  /** Wall-clock work budget; the job stops at its next durable boundary. */
  runBudgetMs?: number;
};

type StatementReadBudget = BudgetMetadata & {
  surface: "statement";
  /** Shared buffers (hit plus read) per call. */
  pages: number;
};

/**
 * One run of a scheduled job. Each measured statement is a read or a write;
 * reads and writes are budgeted separately, so a job's write volume cannot
 * hide a read regression and the other way around.
 */
type ScheduledJobBudget = BudgetMetadata & {
  surface: "scheduled-job";
  /** Shared buffers (hit plus read) the run's reading statements touch. */
  reads: { pages: number };
  /** An existing whole-run envelope retained across read/write classification. */
  combinedPagesPerRun?: number;
  /** Required exactly when the measured run writes rows or write pages. */
  writes?: {
    pagesPerWrittenRow: number;
    ceilingPagesPerRun: number;
    reason: string;
  };
};

export type ReadBudget = StatementReadBudget | ScheduledJobBudget;
