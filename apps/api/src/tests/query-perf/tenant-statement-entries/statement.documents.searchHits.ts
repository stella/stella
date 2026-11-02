import { buildDocumentSearchQueries } from "@/api/lib/search/pg-fts-search-query";

import type { TenantStatementMeasurement } from "../measurement-definition";
import { QUERY_PERF_OWNER_DEADLINES } from "../owner-deadlines";
import type { seedQueryPerf } from "../seed";

const measureDocumentSearch = (
  seed: Awaited<ReturnType<typeof seedQueryPerf>>,
) =>
  ({
    budgetId: "statement.documents.searchHits",
    query: buildDocumentSearchQueries(seed.searchInput).hitsQuery,
    expectedRows: Math.min(seed.searchMatchCount, seed.searchInput.limit + 1),
    ownerDeadlineMs:
      QUERY_PERF_OWNER_DEADLINES["statement.documents.searchHits"],
  }) as const satisfies TenantStatementMeasurement;

export default measureDocumentSearch;
