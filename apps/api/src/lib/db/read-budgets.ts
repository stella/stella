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

type BudgetMetadata = {
  surface: "scheduled-job" | "statement";
  /** Shared buffers (hit plus read) per call or per run. */
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
  pages: number;
};

type ScheduledJobBudget = BudgetMetadata & {
  surface: "scheduled-job";
  reads: { pages: number };
  writes?: {
    pagesPerWrittenRow: number;
    ceilingPagesPerRun: number;
    reason: string;
  };
};

type ReadBudget = StatementReadBudget | ScheduledJobBudget;

export const READ_BUDGETS = {
  "scheduled.caseLaw.refreshCoverage": {
    surface: "scheduled-job",
    reads: { pages: 150 },
    writes: {
      pagesPerWrittenRow: 30,
      ceilingPagesPerRun: 150,
      reason:
        "The measured refresh writes its bounded summary and audit rows within the existing 150-page run envelope.",
    },
    reason:
      "A governed coverage refresh reads the source policy, computes the bounded coverage snapshot, and writes its summary and audit record. The production-shape corpus fixture measures 89 pages; 150 pages leaves more than 50% headroom for production-height indexes.",
    overBudget: {
      reason:
        "Source ranking reads every court bucket before the top-N cut; per-source top-N court buckets materialized at facet refresh bring it under.",
    },
  },
  "statement.caseLaw.globalSearchHits": {
    surface: "statement",
    pages: 6000,
    reason:
      "Fixed 200 full-text matches: up to 12 pages each for eligibility and ranking, then 11 returned rows at up to 256 pages each for decision/search-document/identifier lookups and wide TOAST-backed section bodies, with 784 pages for the full-text probe and index depth. Body reads must depend on the returned page, not all matches.",
  },
  "scheduled.requests.sweepReceipts": {
    surface: "scheduled-job",
    reads: { pages: 20_000 },
    writes: {
      pagesPerWrittenRow: 30,
      ceilingPagesPerRun: 20_000,
      reason:
        "Thirty pages per deleted receipt cover indexed deletion and constraints; the run retains the existing 20,000-page envelope.",
    },
    reason:
      "Four rounds each discover at most 128 completed and 128 pending receipts, then lock and delete at most 128 scoped rows: 2,048 row visits. Nine index/heap pages per visit leave 1,568 pages for tenant-scope reads and fixed probes under the 20,000-page ungoverned ceiling. State-leading ordered expiry probes keep this independent of total receipt cardinality; PostgreSQL measures quiet, expired and mixed cohorts at both sizes.",
  },
  "scheduled.caseLaw.backfillProvisionState": {
    surface: "scheduled-job",
    reads: { pages: 13_200 },
    writes: {
      pagesPerWrittenRow: 30,
      ceilingPagesPerRun: 300_000,
      reason:
        "A 200-unit measured run writes 10,000 state rows and touches about 242,000-249,000 write pages. 300,000 pages leaves roughly 20% headroom; the load governor remains the runtime brake.",
    },
    reason:
      "A governed run checks the shared backfill checkpoint and processes at most 200 bounded provision-state units; a completed pass reads only the checkpoint. 13,200 pages is the target for a run with pending units.",
    overBudget: {
      reason:
        "Typed measurement attributes the nested state inserts to writes, but the remaining primary-key lock reads measure about 26,900 pages at both fixture sizes, above the 13,200-page read target.",
    },
  },
  "scheduled.legislation.backfillExpressionIds": {
    surface: "scheduled-job",
    reads: { pages: 1600 },
    writes: {
      pagesPerWrittenRow: 30,
      ceilingPagesPerRun: 64,
      reason:
        "The measured bounded pass writes only its checkpoint rows, at 18 write pages per run; 64 pages leaves headroom for production-height indexes.",
    },
    reason:
      "A completed pass checks the shared backfill checkpoint and scans one bounded expression-id page. The production-shape corpus fixture measures 1,057 pages; 1,600 pages leaves 50% headroom for production-height indexes.",
  },
  "statement.caseLaw.coverageSources": {
    surface: "statement",
    pages: 256,
    reason:
      "Four fixture sources: eight date endpoint seeks at eight pages each (64), ninety precomputed court rows at two pages each (180), and twelve pages for the twenty-row uncached court source and grouped pending-text read: 256 pages total. Rejected filing dates must cost no heap walk.",
  },
  "statement.caseLaw.euCompletionPage": {
    surface: "statement",
    pages: 1500,
    statementDeadlineMs: 10_000,
    reason:
      "One 100-row completion page measured against a fully completed 100,000-decision source: 1,201 shared pages, plus 299 pages (25% headroom) for B-tree layout variation. The source page, receipt, and index-job decision indexes bound work before eligibility filtering.",
  },
  "scheduled.caseLaw.reportFreshness": {
    surface: "scheduled-job",
    reads: { pages: 12_500 },
    reason:
      "One walk of the serving generation's queue index, capped at CASE_LAW_FRESHNESS_SCAN_CAP + 1 entries with at most one heap page each (about 10,200 pages when every entry sits on its own heap page), plus the source ages, the serving generation and three single-row queue probes. The run reads the same pages whatever the generation's size.",
  },
  "scheduled.caseLaw.refreshSitemapShards": {
    surface: "scheduled-job",
    reads: { pages: 18_000 },
    writes: {
      pagesPerWrittenRow: 30,
      ceilingPagesPerRun: 18_000,
      reason:
        "Thirty pages per changed row cover bounded shard, cursor and retirement writes; the run retains the existing 18,000-page envelope.",
    },
    statementDeadlineMs: 30_000,
    runBudgetMs: 15 * 60 * 1000,
    reason:
      "At most 500 change-log discovery rows and retirement candidates combined per run; month recounts persist a snapshot boundary so bounded retirement does not repeat the decision scan. A run stops between months after fifteen minutes, leaving the scheduler ceiling room for its current month, and every statement has a thirty-second database deadline.",
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

export const readBudgetPages = (id: ReadBudgetId) => {
  const budget = READ_BUDGETS[id];
  return budget.surface === "scheduled-job" ? budget.reads.pages : budget.pages;
};

export type ReadBudgetId = keyof typeof READ_BUDGETS;

export type ScheduledJobReadBudgetId = {
  [
    Id in ReadBudgetId
  ]: (typeof READ_BUDGETS)[Id]["surface"] extends "scheduled-job" ? Id : never;
}[ReadBudgetId];

/** SELECT-callable routines whose effects make their whole statement a write. */
export const QUERY_PERF_WRITING_FUNCTIONS: ReadonlySet<string> = new Set([
  "ensure_case_law_provision_extraction_state",
  "run_case_law_provision_scope_transition_page",
]);

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
 * - `{ budget, governance: "load-governed" }`: every batch runs under the
 *   shared load governor and the whole run also stays within its budget.
 * - `"load-governed"`: every batch runs under the shared load governor.
 * - `"unmeasured"`: a job registered before read budgets, listed with its
 *   reason in `read-budgets-unmeasured.json`; that ledger only shrinks.
 */
export type ScheduledJobReads =
  | {
      budget: ScheduledJobReadBudgetId;
      governance?: "load-governed";
    }
  | "load-governed"
  | "unmeasured";

/** The budgets each MCP tool's hot statements are measured against. */
export const MCP_TOOL_READ_BUDGETS = {
  search: ["statement.documents.searchHits"],
  search_across_matters: ["statement.documents.searchHits"],
  search_legislation: ["statement.legislation.candidateRows"],
} as const satisfies Record<string, readonly ReadBudgetId[]>;
