import type { TransactionOf } from "@/api/db/scoped";
import { legislationCandidateRowsStatement } from "@/api/handlers/legislation/search";
import type { LegislationReadTransaction } from "@/api/lib/legislation-public-read-db";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  type CorpusReadBudgetSeed,
  LEGISLATION_CANDIDATE_COUNT,
  LEGISLATION_GENERATION,
} from "../corpus-seed";
import type { CorpusStatementMeasurement } from "../measurement-definition";
import { QUERY_PERF_OWNER_DEADLINES } from "../owner-deadlines";

const measureLegislationCandidates = (seed: CorpusReadBudgetSeed) =>
  ({
    budgetId: "statement.legislation.candidateRows",
    build: (tx: TransactionOf<GatedTestDb>) =>
      // The fixture's transaction supplies the select surface the reader uses.
      legislationCandidateRowsStatement(
        asTestRaw<LegislationReadTransaction>(tx),
        {
          ids: seed.candidateIds,
          generation: LEGISLATION_GENERATION,
          body: { query: "smlouva", jurisdiction: "CZE" },
        },
      ),
    expectedRows: LEGISLATION_CANDIDATE_COUNT,
    ownerDeadlineMs:
      QUERY_PERF_OWNER_DEADLINES["statement.legislation.candidateRows"],
  }) as const satisfies CorpusStatementMeasurement;

export default measureLegislationCandidates;
