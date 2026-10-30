export type ReadBudget = {
  surface: "scheduled-job" | "statement";
  /** Shared buffers (hit plus read) per call or per run. */
  pages: number;
  reason: string;
  /**
   * Set only while a measured statement is over its budget and a change to
   * bring it under is in progress. The gate then requires the measurement to
   * stay above the budget, so the entry is removed as soon as it passes.
   */
  overBudget?: { reason: string };
  /** Per-statement database deadline for a scheduled job. */
  statementDeadlineMs?: number;
  /** Wall-clock work budget; the job stops at its next durable boundary. */
  runBudgetMs?: number;
};
