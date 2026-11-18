import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { ClientOperationError } from "@/lib/errors/client";
import { nullableStringCursorSeed } from "@/lib/infinite-query";
import { unwrapPublicLawResponse } from "@/lib/public-law-api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

/**
 * A consolidated code carries thousands of provisions, so one provision's
 * history is read on demand, a few consolidations at a time: each one costs a
 * document-AST read on the server.
 */
const PAGE_SIZE = 5;

/**
 * The whole history, for grouping every version of the act by the
 * provision's wording: the largest page the endpoint serves, and a bound on
 * the walk so a Work with an unusual number of consolidations cannot keep a
 * menu loading. What lies past the bound is listed without a comparison.
 */
const WALK_PAGE_SIZE = 20;
const WALK_MAX_PAGES = 10;

export type ProvisionHistoryKey = {
  anchor: string;
  documentId: string;
};

const provisionHistoryKeys = {
  all: ["statutes", "provision-history"],
  byAnchor: (key: ProvisionHistoryKey) => [
    ...provisionHistoryKeys.all,
    { anchor: key.anchor, documentId: key.documentId },
  ],
  walk: (key: ProvisionHistoryKey) => [
    ...provisionHistoryKeys.byAnchor(key),
    "walk",
  ],
};

type ReadPageOptions = {
  cursor: string | null;
  key: ProvisionHistoryKey;
  limit: number;
  signal: AbortSignal;
};

const readProvisionHistoryPage = async ({
  cursor,
  key,
  limit,
  signal,
}: ReadPageOptions) => {
  const response = await api.law
    .statutes({
      documentId: toSafeId<"legislationDocument">(key.documentId),
    })
    .provisions({ anchor: key.anchor })
    .history.get({
      query: { limit, ...(cursor === null ? {} : { cursor }) },
      fetch: { signal },
    });

  return unwrapPublicLawResponse(response, "readPublicProvisionHistory");
};

export type ProvisionHistoryItem = Awaited<
  ReturnType<typeof readProvisionHistoryPage>
>["items"][number];

/** One provision's wording per consolidation of its Work, newest first. */
export const provisionHistoryOptions = (key: ProvisionHistoryKey) =>
  infiniteQueryOptions({
    queryKey: provisionHistoryKeys.byAnchor(key),
    queryFn: async ({ pageParam, signal }) =>
      await readProvisionHistoryPage({
        cursor: pageParam,
        key,
        limit: PAGE_SIZE,
        signal,
      }),
    initialPageParam: nullableStringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

/**
 * The history read to its end, or to the walk's bound: `complete` says
 * whether every version of the Work was read.
 */
export type ProvisionHistoryWalk = {
  complete: boolean;
  items: ProvisionHistoryItem[];
};

type WalkOptions = {
  collected: ProvisionHistoryItem[];
  cursor: string | null;
  key: ProvisionHistoryKey;
  pagesLeft: number;
  signal: AbortSignal;
};

// Each page names the next one, so the walk is sequential by construction.
const walkProvisionHistory = async ({
  collected,
  cursor,
  key,
  pagesLeft,
  signal,
}: WalkOptions): Promise<ProvisionHistoryWalk> => {
  const page = await readProvisionHistoryPage({
    cursor,
    key,
    limit: WALK_PAGE_SIZE,
    signal,
  });
  collected.push(...page.items);

  if (page.nextCursor === null) {
    return { complete: true, items: collected };
  }
  if (pagesLeft <= 1) {
    getAnalytics().captureError(
      new ClientOperationError({
        action: "statutes.provision-history-walk",
        message: "Provision history walk stopped at the page cap",
      }),
      {
        fingerprintKey: "walkProvisionHistory:ClientOperationError",
        scope: {
          type: "handler",
          handlerId: "walkProvisionHistory:ClientOperationError",
        },
      },
    );
    return { complete: false, items: collected };
  }
  return await walkProvisionHistory({
    collected,
    cursor: page.nextCursor,
    key,
    pagesLeft: pagesLeft - 1,
    signal,
  });
};

/**
 * Every consolidation's wording of one provision, for the version menu that
 * groups the act's versions by it. Read when the menu opens, not with the
 * pane: each version costs the server one document read.
 */
export const provisionHistoryWalkOptions = (key: ProvisionHistoryKey) =>
  queryOptions({
    queryKey: provisionHistoryKeys.walk(key),
    queryFn: async ({ signal }) =>
      await walkProvisionHistory({
        collected: [],
        cursor: null,
        key,
        pagesLeft: WALK_MAX_PAGES,
        signal,
      }),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
