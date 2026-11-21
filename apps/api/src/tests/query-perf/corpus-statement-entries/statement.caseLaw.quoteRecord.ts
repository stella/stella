import type { TransactionOf } from "@/api/db/scoped";
import { decisionRecordQuery } from "@/api/handlers/case-law/decisions/get";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import type { CorpusReadBudgetSeed } from "../corpus-seed";
import type { CorpusStatementMeasurement } from "../measurement-definition";
import { QUERY_PERF_OWNER_DEADLINES } from "../owner-deadlines";

const measureQuoteRecord = (seed: CorpusReadBudgetSeed) =>
  ({
    budgetId: "statement.caseLaw.quoteRecord",
    build: (tx: TransactionOf<GatedTestDb>) =>
      decisionRecordQuery(
        asTestRaw<CaseLawPublicReadTransaction>(tx),
        seed.quoteDecisionId,
      ),
    expectedRows: 1,
    ownerDeadlineMs:
      QUERY_PERF_OWNER_DEADLINES["statement.caseLaw.quoteRecord"],
  }) as const satisfies CorpusStatementMeasurement;

export default measureQuoteRecord;
