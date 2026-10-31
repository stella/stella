import { panic, TaggedError } from "better-result";

import { HTTP_REQUEST_DATABASE_BUDGET_MS } from "../../http/timeout-policy.ts";
import { READ_BUDGETS } from "./read-budgets.ts";

type TransactionBudget =
  | {
      kind: "aggregate";
      milliseconds: 5000 | 30_000 | 90_000 | 119_000;
      reason: string;
    }
  | {
      kind: "lease-coordinated";
      owner: string;
      envelopeMs: number;
      tables: readonly string[];
      transactionEntries: number;
      statementDeadline: { kind: "fixed"; milliseconds: number };
      reason: string;
    }
  | {
      kind: "uncapped-pending-measurement";
      owner: string;
      entryPoint: string;
      callers: readonly string[];
      reason: string;
    };

/** Ordinary transactions end before online DDL's ladder; long scheduler jobs retain their existing policy until lease cutover. */
export const AGGREGATE_TRANSACTION_BUDGETS = {
  deadlineProbe: {
    kind: "aggregate",
    milliseconds: 5000,
    reason:
      "short deadline-owner regression probe; production requests use scopedRequest",
  },
  scopedRequest: {
    kind: "aggregate",
    milliseconds: HTTP_REQUEST_DATABASE_BUDGET_MS,
    reason:
      "scoped requests share the existing 30-second public-read budget within the 75-second HTTP transport window",
  },
  publicReadRequest: {
    kind: "aggregate",
    milliseconds: HTTP_REQUEST_DATABASE_BUDGET_MS,
    reason:
      "anonymous reads share their existing 30-second statement deadline and remain inside the HTTP transport window",
  },
  backgroundBatch: {
    kind: "aggregate",
    milliseconds: 30_000,
    reason: "bounded worker batch",
  },
  corpusRefresh: {
    kind: "aggregate",
    milliseconds: 90_000,
    reason: "bounded public-corpus refresh",
  },
  corpusRepair: {
    kind: "aggregate",
    milliseconds: 119_000,
    reason:
      "2,000-row JSONB repair with a 100-second statement deadline; below the migration ladder",
  },
  migrationCeiling: {
    kind: "aggregate",
    milliseconds: 119_000,
    reason: "strictly below the 120-second online-DDL lock retry ladder",
  },
  corpusSliceExport: {
    kind: "uncapped-pending-measurement",
    owner: "apps/api/src/lib/case-law/corpus-slice-transfer-execution.ts",
    entryPoint: "exportCorpusSliceFromDatabase",
    callers: ["apps/api/src/scripts/export-corpus-slice.ts"],
    reason:
      "retain the consistent export snapshot until realistic corpus and storage runtimes justify a total deadline",
  },
  reviewOrganizationReset: {
    kind: "uncapped-pending-measurement",
    owner: "apps/api/src/lib/review-organization/reset.ts",
    entryPoint: "resetReviewOrganization",
    callers: ["apps/api/src/lib/scheduler/tasks/review-organization-reset.ts"],
    reason:
      "scheduler-only organization resets retain their existing uncapped policy until measured reset runtimes justify a deadline",
  },
  scopedWorkerPendingMeasurement: {
    kind: "uncapped-pending-measurement",
    owner: "apps/api/src/db/scoped.ts",
    entryPoint: "runScopedTransaction",
    callers: ["apps/api/src/db/scoped.ts"],
    reason:
      "worker-scoped transactions retain their existing uncapped policy until measured production runtimes justify a deadline",
  },
  sitemapRefresh: {
    kind: "lease-coordinated",
    owner: "apps/api/src/lib/case-law/sitemap-shard-refresh.ts",
    transactionEntries: 3,
    envelopeMs:
      13 *
      READ_BUDGETS["scheduled.caseLaw.refreshSitemapShards"]
        .statementDeadlineMs,
    tables: [
      "case_law_decisions",
      "case_law_published_decisions",
      "case_law_sources",
      "case_law_sitemap_changes",
      "case_law_sitemap_country_generations",
      "case_law_sitemap_drain_progress",
      "case_law_sitemap_refresh_cursor",
      "case_law_sitemap_shard_counts",
      "case_law_sitemap_shards",
      "case_law_browse_facet_counts",
      "case_law_coverage_summaries",
      "case_law_source_arrivals",
      "system_audit_runs",
    ],
    statementDeadline: {
      kind: "fixed",
      milliseconds:
        READ_BUDGETS["scheduled.caseLaw.refreshSitemapShards"]
          .statementDeadlineMs,
    },
    reason:
      "four publication + two retirement + six setup/fence/read statements + budget setup; legacy connection policy until scheduler table-lease cutover",
  },
  legislationFacetRefresh: {
    kind: "lease-coordinated",
    owner: "apps/api/src/lib/legal-search/legislation-facet-refresh.ts",
    transactionEntries: 1,
    envelopeMs: 5 * 300_000,
    tables: [
      "legislation_documents",
      "legislation_facet_counts",
      "legislation_facet_refreshes",
      "system_audit_runs",
    ],
    statementDeadline: { kind: "fixed", milliseconds: 300_000 },
    reason:
      "atomic whole-corpus facet snapshot; five statements, no input row cap; legacy connection policy until scheduler table-lease cutover",
  },
  sourceArrivalsRefresh: {
    kind: "lease-coordinated",
    owner: "apps/api/src/lib/case-law/source-arrivals-refresh.ts",
    transactionEntries: 1,
    envelopeMs: 3 * 120_000,
    tables: [
      "case_law_decisions",
      "case_law_published_decisions",
      "case_law_sources",
      "case_law_source_arrivals",
      "system_audit_runs",
    ],
    statementDeadline: { kind: "fixed", milliseconds: 120_000 },
    reason:
      "atomic whole-corpus arrivals snapshot; three statements, no input row cap; legacy connection policy until scheduler table-lease cutover",
  },
  skipLockedBatchPendingMeasurement: {
    kind: "uncapped-pending-measurement",
    owner: "apps/api/src/lib/db/aggregate-lock.ts",
    entryPoint: "withSkipLockedBatch",
    callers: [
      "apps/api/src/lib/idempotency/request-receipts.ts",
      "apps/api/src/lib/business-registries/desktop/proof-store.ts",
    ],
    reason:
      "retain existing background batch behavior until measured production runtimes justify a deadline",
  },
  rootSavepointPendingMeasurement: {
    kind: "uncapped-pending-measurement",
    owner: "apps/api/src/lib/db/aggregate-lock.ts",
    entryPoint: "withAggregateSavepoint",
    callers: [
      "apps/api/src/db/scoped.ts",
      "apps/api/src/db/safe-db.ts",
      "apps/api/src/handlers/skills/resources/delete.ts",
      "apps/api/src/handlers/skills/resources/upload.ts",
      "apps/api/src/handlers/skills/resources/create.ts",
      "apps/api/src/handlers/skills/resources/rename.ts",
      "apps/api/src/lib/skills/install.ts",
      "apps/api/src/lib/ai-config-loader.ts",
      "apps/api/src/lib/db/aggregate-lock.ts",
      "apps/api/src/lib/agent-skills/skill-tools.ts",
      "apps/api/src/lib/idempotency/request-receipts.ts",
      "apps/api/src/lib/case-law/maintenance-lane.ts",
    ],
    reason:
      "root fallback retains existing behavior until measured runtimes justify a deadline; savepoints inherit their parent's deadline",
  },
} as const satisfies Record<string, TransactionBudget>;

export type AggregateTransactionBudget = Extract<
  (typeof AGGREGATE_TRANSACTION_BUDGETS)[keyof typeof AGGREGATE_TRANSACTION_BUDGETS],
  { kind: "aggregate" | "uncapped-pending-measurement" }
>;

type TighterTransactionBudgetOptions = {
  declared: AggregateTransactionBudget;
  requested: AggregateTransactionBudget | undefined;
};

/** Explicit and ambient policies compose monotonically; ties preserve the declared owner. */
export const tighterTransactionBudget = ({
  declared,
  requested,
}: TighterTransactionBudgetOptions): AggregateTransactionBudget => {
  if (requested === undefined) {
    return declared;
  }
  switch (declared.kind) {
    case "uncapped-pending-measurement":
      return requested.kind === "aggregate" ? requested : declared;
    case "aggregate":
      return requested.kind === "uncapped-pending-measurement" ||
        declared.milliseconds <= requested.milliseconds
        ? declared
        : requested;
    default:
      return panic(
        "Unknown declared transaction budget",
        declared satisfies never,
      );
  }
};

export class AggregateTransactionTimeoutError extends TaggedError(
  "AggregateTransactionTimeoutError",
)<{
  message: string;
  cause: unknown;
  budget: Extract<AggregateTransactionBudget, { kind: "aggregate" }>;
  reason: string;
}> {}

export type ScopedTransactionBudget =
  | typeof AGGREGATE_TRANSACTION_BUDGETS.scopedRequest
  | typeof AGGREGATE_TRANSACTION_BUDGETS.scopedWorkerPendingMeasurement;
