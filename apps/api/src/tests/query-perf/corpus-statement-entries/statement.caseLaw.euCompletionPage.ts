import type { TransactionOf } from "@/api/db/scoped";
import { buildEuCompletionPageQuery } from "@/api/handlers/case-law/ingestion/eu-completion-store";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import type { CorpusReadBudgetSeed } from "../corpus-seed";
import type { CorpusStatementMeasurement } from "../measurement-definition";
import { QUERY_PERF_OWNER_DEADLINES } from "../owner-deadlines";

const measureEuCompletionPage = (seed: CorpusReadBudgetSeed) =>
  ({
    budgetId: "statement.caseLaw.euCompletionPage",
    build: (tx: TransactionOf<GatedTestDb>) =>
      buildEuCompletionPageQuery(tx, {
        sourceId: seed.completionSourceId,
        mode: "dry-run",
        parserVersion: 2,
        after: null,
        limit: 100,
      }),
    expectedRows: 100,
    read: async (tx: TransactionOf<GatedTestDb>) =>
      await buildEuCompletionPageQuery(tx, {
        sourceId: seed.completionSourceId,
        mode: "dry-run",
        parserVersion: 2,
        after: null,
        limit: 100,
      }),
    ownerDeadlineMs:
      QUERY_PERF_OWNER_DEADLINES["statement.caseLaw.euCompletionPage"],
  }) as const satisfies CorpusStatementMeasurement;

export default measureEuCompletionPage;
