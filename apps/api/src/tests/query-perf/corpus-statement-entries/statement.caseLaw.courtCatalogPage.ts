import { admittedCourtPageStatement } from "@/api/handlers/case-law/decisions/shelf-courts";
import { LIMITS } from "@/api/lib/limits";

import {
  type CorpusReadBudgetSeed,
  COURT_CATALOG_COUNTRY,
} from "../corpus-seed";
import type { CorpusStatementMeasurement } from "../measurement-definition";
import { QUERY_PERF_OWNER_DEADLINES } from "../owner-deadlines";

const measureCourtCatalogPage = (_seed: CorpusReadBudgetSeed) =>
  ({
    budgetId: "statement.caseLaw.courtCatalogPage",
    build: () =>
      admittedCourtPageStatement({
        country: COURT_CATALOG_COUNTRY,
        excludedSourceIds: [],
        after: null,
        limit: LIMITS.mcpListPageSizeMax,
      }),
    // A full page and the one court that says another page follows.
    expectedRows: LIMITS.mcpListPageSizeMax + 1,
    ownerDeadlineMs:
      QUERY_PERF_OWNER_DEADLINES["statement.caseLaw.courtCatalogPage"],
  }) as const satisfies CorpusStatementMeasurement;

export default measureCourtCatalogPage;
