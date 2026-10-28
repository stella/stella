/**
 * Read budgets: how many shared buffers (8 KiB pages, hit or read) one call
 * of a hot statement, or one run of a scheduled job, may touch.
 *
 * Budgets are absolute. The query-perf gate (`apps/api/src/tests/query-perf`)
 * measures each one with `EXPLAIN (ANALYZE, BUFFERS)` on its fixture and fails
 * when a measurement exceeds the number here; nothing is compared with an
 * earlier recording, so a cost that has been high for weeks fails as surely as
 * a new one. A budget states the work its statement must do (rows it returns
 * or walks, times the pages each one costs on a production-sized index), and
 * its reason says how the number was derived.
 *
 * Every declared scheduled job states its reads in its registration
 * (`DECLARED_SCHEDULER_JOBS`), and every MCP tool appears in
 * `MCP_TOOL_READ_BUDGETS` or in the shrink-only ledger beside this file, so a
 * new job or tool without a declaration fails the census in
 * `read-budgets.test.ts`.
 */

type ReadBudget = {
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
};

export const READ_BUDGETS = {
  "scheduled.caseLaw.reportFreshness": {
    surface: "scheduled-job",
    pages: 12_500,
    reason:
      "One walk of the serving generation's queue index, capped at CASE_LAW_FRESHNESS_SCAN_CAP + 1 entries with at most one heap page each (about 10,200 pages when every entry sits on its own heap page), plus the source ages, the serving generation, three single-row queue probes and two eligible full-text partial-index probes per registered source (one missing-state row and at most failedThreshold + 1 failed rows). Both walks stay bounded as their corpora grow.",
  },
  "statement.legislation.candidateRows": {
    surface: "statement",
    pages: 6600,
    reason:
      "Rehydrates one page of 300 candidate ids: per candidate, the document by primary key twice (eligibility and the id-only join), one projection-state lookup, one revision lookup and one sibling probe, each about four to five pages deep on a production-sized index (22 pages per candidate).",
    overBudget: {
      reason:
        "Eligibility, the applied revision and the recurrence check each look up the same projection state; the state is read three times per candidate.",
    },
  },
  "statement.documents.searchHits": {
    surface: "statement",
    pages: 1550,
    reason:
      "One page of document-search hits under row security, measured on the growth profile (100,000 documents, 200 matches, one matter in a hundred selected): the full-text index probe of the matches plus their entity and membership checks.",
  },
} as const satisfies Record<string, ReadBudget>;

export type ReadBudgetId = keyof typeof READ_BUDGETS;

export type ScheduledJobReadBudgetId = {
  [
    Id in ReadBudgetId
  ]: (typeof READ_BUDGETS)[Id]["surface"] extends "scheduled-job" ? Id : never;
}[ReadBudgetId];

/**
 * Pages one run of a scheduled job may read outside the shared load governor.
 * Work that needs more per run batches through `backfill-runtime`, which
 * shrinks and holds its batches under database load.
 */
export const UNGOVERNED_SCHEDULED_JOB_PAGE_CEILING = 20_000;

/**
 * What one run of a scheduled job reads, declared in its registration.
 *
 * - `{ budget }`: measured per run on the corpus fixture; the run must read
 *   at most the budget, and the same pages at twice the corpus size.
 * - `"load-governed"`: every batch runs under the shared load governor.
 * - `"unmeasured"`: a job registered before read budgets, listed with its
 *   reason in `read-budgets-unmeasured.json`; that ledger only shrinks.
 */
export type ScheduledJobReads =
  { budget: ScheduledJobReadBudgetId } | "load-governed" | "unmeasured";

/** The budgets each MCP tool's hot statements are measured against. */
export const MCP_TOOL_READ_BUDGETS = {
  search: ["statement.documents.searchHits"],
  search_across_matters: ["statement.documents.searchHits"],
  search_legislation: ["statement.legislation.candidateRows"],
} as const satisfies Record<string, readonly ReadBudgetId[]>;
