import { infiniteQueryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { nullableStringCursorSeed } from "@/lib/infinite-query";
import { unwrapPublicLawEden } from "@/lib/public-law-api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

/**
 * A consolidated code carries thousands of provisions, so one provision's
 * history is read on demand, a few consolidations at a time: each one costs a
 * document-AST read on the server.
 */
const PAGE_SIZE = 5;

export type ProvisionHistoryKey = {
  anchor: string;
  documentId: string;
};

export const provisionHistoryKeys = {
  all: ["statutes", "provision-history"],
  byAnchor: (key: ProvisionHistoryKey) => [
    ...provisionHistoryKeys.all,
    { anchor: key.anchor, documentId: key.documentId },
  ],
};

/** One provision's wording per consolidation of its Work, newest first. */
export const provisionHistoryOptions = (key: ProvisionHistoryKey) =>
  infiniteQueryOptions({
    queryKey: provisionHistoryKeys.byAnchor(key),
    queryFn: async ({ pageParam, signal }) => {
      const response = await api.law
        .statutes({
          documentId: toSafeId<"legislationDocument">(key.documentId),
        })
        .provisions({ anchor: key.anchor })
        .history.get({
          query: {
            limit: PAGE_SIZE,
            ...(pageParam === null ? {} : { cursor: pageParam }),
          },
          fetch: { signal },
        });

      const data = unwrapPublicLawEden(response, "readPublicProvisionHistory");

      return data;
    },
    initialPageParam: nullableStringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
