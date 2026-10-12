import { buildDocumentSearchQueries } from "@/api/lib/search/pg-fts-search-query";

import type { seedQueryPerf } from "./seed";

export const queryPerfRegistry = (
  seed: Awaited<ReturnType<typeof seedQueryPerf>>,
) => ({
  "document-search": {
    query: buildDocumentSearchQueries(seed.searchInput).hitsQuery,
    expectedRows: Math.min(seed.searchMatchCount, seed.searchInput.limit + 1),
  },
});
