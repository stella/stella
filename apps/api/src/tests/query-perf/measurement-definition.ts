import type { SQLWrapper } from "drizzle-orm";

import type { TransactionOf } from "@/api/db/scoped";
import type { ReadBudgetId } from "@/api/lib/db/read-budgets";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import type { seedSitemapReadBudget, ServedCaseLaw } from "./corpus-seed";
import type { RecoveryScenario } from "./recovery-measurement";
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
type CaseLawScenario = { type: "case-law"; served: ServedCaseLaw };
export type ScheduledJobScenario = CaseLawScenario | RequestReceiptScenario;
type CaseLawScheduledJobMeasurement = {
  type: "case-law";
  prepare?: typeof seedSitemapReadBudget;
  /**
   * Whether the run did the job's work, read before `prepare` restores the
   * fixture. A governed job the load governor held issues only its bookkeeping,
   * and its statements would pass a budget without measuring the work.
   */
  executed?: (database: GatedTestDb) => Promise<boolean>;
  task: string;
  scenarios: readonly {
    size: CaseLawScenario;
    double?: CaseLawScenario;
  }[];
};
type RequestReceiptScheduledJobMeasurement = {
  type: "request-receipts";
  task: string;
  scenarios: readonly {
    size: RequestReceiptScenario;
    double?: RequestReceiptScenario;
  }[];
};
type RecoveryScheduledJobMeasurement = {
  type: "recovery";
  task: string;
  scenarios: readonly Omit<RecoveryScenario, "rows">[];
};
/**
 * Every budgeted job is keyed by its registered ID and carries its task.
 * Measurement kind selects the corpus owner that runs its scenarios.
 */
export type ScheduledJobMeasurement =
  | CaseLawScheduledJobMeasurement
  | RequestReceiptScheduledJobMeasurement
  | RecoveryScheduledJobMeasurement;
