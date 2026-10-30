import type { SQLWrapper } from "drizzle-orm";

import type { TransactionOf } from "@/api/db/scoped";
import type { ReadBudgetId } from "@/api/lib/db/read-budgets";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import type { seedSitemapReadBudget, ServedCaseLaw } from "./corpus-seed";
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
  expectedRows: number;
  ownerDeadlineMs: number | undefined;
};
export type ScheduledJobScenario =
  { type: "case-law"; served: ServedCaseLaw } | RequestReceiptScenario;
export type ScheduledJobMeasurement = {
  prepare?: typeof seedSitemapReadBudget;
  task: string;
  scenarios: readonly {
    size: ScheduledJobScenario;
    double?: ScheduledJobScenario;
  }[];
};
