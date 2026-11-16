import type { TransactionOf } from "@/api/db/scoped";
import { servableCandidateRevisionsStatement } from "@/api/handlers/case-law/decisions/search";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  CASE_LAW_SEARCH_CANDIDATE_COUNT,
  CASE_LAW_SEARCH_GENERATION,
  type CorpusReadBudgetSeed,
} from "../corpus-seed";
import type { CorpusStatementMeasurement } from "../measurement-definition";
import { QUERY_PERF_OWNER_DEADLINES } from "../owner-deadlines";

const measureServableCandidateRevisions = (seed: CorpusReadBudgetSeed) =>
  ({
    budgetId: "statement.caseLaw.servableCandidateRevisions",
    build: (tx: TransactionOf<GatedTestDb>) =>
      servableCandidateRevisionsStatement(
        asTestRaw<CaseLawPublicReadTransaction>(tx),
        {
          body: { country: "CZE" },
          generation: CASE_LAW_SEARCH_GENERATION,
          ids: seed.caseLawSearchCandidateIds,
        },
      ),
    expectedRows: CASE_LAW_SEARCH_CANDIDATE_COUNT,
    ownerDeadlineMs:
      QUERY_PERF_OWNER_DEADLINES[
        "statement.caseLaw.servableCandidateRevisions"
      ],
  }) as const satisfies CorpusStatementMeasurement;

export default measureServableCandidateRevisions;
