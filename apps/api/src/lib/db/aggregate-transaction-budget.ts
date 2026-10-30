import { TaggedError } from "better-result";

import type { DEFAULT_LOCK_RETRY_CONFIG } from "../../db/lock-retry-ladder";
import { READ_BUDGETS } from "./read-budgets";

type TransactionBudget =
  | {
      kind: "aggregate";
      milliseconds: 5000 | 30_000 | 90_000 | 120_000;
      reason: string;
    }
  | {
      kind: "statement-envelope";
      milliseconds: number;
      reason: string;
    }
  | {
      kind: "dedicated-deadline";
      owner: string;
      statementDeadline:
        | { kind: "fixed"; milliseconds: number }
        | {
            kind: "connection-policy";
            environment: "DATABASE_STATEMENT_TIMEOUT_MS";
          };
      reason: string;
    };

/** Default aggregate budgets respect the DDL ceiling; longer envelopes require an explicit derivation. */
export const AGGREGATE_TRANSACTION_BUDGETS = {
  requestPath: {
    kind: "aggregate",
    milliseconds: 5000,
    reason: "interactive request-path work",
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
    milliseconds: 120_000,
    reason: "2,000-row JSONB repair with a 100-second statement deadline",
  },
  sitemapRefresh: {
    kind: "statement-envelope",
    milliseconds:
      13 *
      READ_BUDGETS["scheduled.caseLaw.refreshSitemapShards"]
        .statementDeadlineMs,
    reason: `sitemap: four publication + two retirement + six settings/fence/read statements + budget setup; thirteen ${READ_BUDGETS["scheduled.caseLaw.refreshSitemapShards"].statementDeadlineMs}ms deadlines; lock waits retain the refresh lock timeout`,
  },
  migrationCeiling: {
    kind: "aggregate",
    milliseconds: 120_000,
    reason: "online-DDL lock retry ceiling",
  },
  legislationFacetRefresh: {
    kind: "dedicated-deadline",
    owner: "apps/api/src/lib/legal-search/legislation-facet-refresh.ts",
    statementDeadline: { kind: "fixed", milliseconds: 300_000 },
    reason:
      "atomic whole-corpus facet snapshot; five statements, no input row cap",
  },
  sourceArrivalsRefresh: {
    kind: "dedicated-deadline",
    owner: "apps/api/src/lib/case-law/source-arrivals-refresh.ts",
    statementDeadline: { kind: "fixed", milliseconds: 120_000 },
    reason:
      "atomic whole-corpus arrival snapshot; three statements, no input row cap",
  },
  corpusSliceExport: {
    kind: "dedicated-deadline",
    owner: "apps/api/src/lib/case-law/corpus-slice-transfer-execution.ts",
    statementDeadline: {
      kind: "connection-policy",
      environment: "DATABASE_STATEMENT_TIMEOUT_MS",
    },
    reason:
      "one read-only repeatable snapshot across all export pages and storage writes; no total duration cap",
  },
} as const satisfies Record<string, TransactionBudget> & {
  migrationCeiling: {
    milliseconds: typeof DEFAULT_LOCK_RETRY_CONFIG.budgetMs;
    reason: string;
  };
};

export type AggregateTransactionBudget = Extract<
  (typeof AGGREGATE_TRANSACTION_BUDGETS)[keyof typeof AGGREGATE_TRANSACTION_BUDGETS],
  { kind: "aggregate" | "statement-envelope" }
>;

export class AggregateTransactionTimeoutError extends TaggedError(
  "AggregateTransactionTimeoutError",
)<{
  message: string;
  cause: unknown;
  budget: AggregateTransactionBudget;
  reason: string;
}> {}
