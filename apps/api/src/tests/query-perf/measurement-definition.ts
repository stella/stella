import type { SQLWrapper } from "drizzle-orm";

import type { TransactionOf } from "@/api/db/scoped";
import type { ReadBudgetId } from "@/api/lib/db/read-budgets";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import type { seedSitemapReadBudget, ServedCaseLaw } from "./corpus-seed";
import type { DataExportScenario } from "./data-export-seed";
import type { RequestReceiptScenario } from "./request-receipt-seed";

export type TenantStatementMeasurement = {
  budgetId: ReadBudgetId;
  query: SQLWrapper;
  expectedRows: number;
  ownerDeadlineMs: number | undefined;
};
export type CorpusStatementMeasurement = {
  budgetId: ReadBudgetId;
  build: (tx: TransactionOf<GatedTestDb>) => SQLWrapper;
  read?: (tx: TransactionOf<GatedTestDb>) => Promise<unknown[]>;
  expectedRows: number;
  ownerDeadlineMs: number | undefined;
};
export type ScheduledJobScenario =
  | { type: "case-law"; served: ServedCaseLaw }
  | RequestReceiptScenario
  | DataExportScenario;
export type ScheduledJobMeasurement = {
  prepare?: typeof seedSitemapReadBudget;
  /**
   * Whether the run did the job's work, read before `prepare` restores the
   * fixture. A governed job the load governor held issues only its bookkeeping,
   * and its statements would pass a budget without measuring the work.
   */
  executed?: (database: GatedTestDb) => Promise<boolean>;
  task: string;
  scenarios: readonly {
    size: ScheduledJobScenario;
    double?: ScheduledJobScenario;
  }[];
};
