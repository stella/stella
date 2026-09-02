import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { APIError } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import { nullableStringCursorSeed } from "@/lib/infinite-query";
import { toPublicLawError, unwrapPublicLawEden } from "@/lib/public-law-api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

const DEFAULT_PAGE_SIZE = 50;
const NOT_FOUND_STATUS = 404;
const VERSIONS_PAGE_SIZE = 200;
/**
 * Consolidated versions are read as a whole, because the switcher offers the
 * whole set. The walk is still bounded: a work that needs more pages than
 * this is a corpus fault, reported rather than silently cut short.
 */
const VERSIONS_MAX_PAGES = 5;

export type StatuteListFilters = {
  /** Narrows an act-number lookup to one publisher collection (`sb`, `zz`). */
  collection?: string;
  country: string;
  language?: string;
  /** An act number, `<number>/<year>`: the list resolves that work. */
  number?: string;
  query?: string;
};

/**
 * A Work plus the date to read it at. The identifier addresses the Work and
 * the date picks the consolidation, so the trio is the cache identity.
 */
export type StatuteAsOfKey = {
  asOf: string;
  eli: string;
  language: string;
};

export const statuteKeys = {
  all: ["statutes"],
  list: (filters: StatuteListFilters) => [
    ...statuteKeys.all,
    "list",
    {
      collection: filters.collection,
      country: filters.country,
      language: filters.language,
      number: filters.number,
      query: filters.query,
    },
  ],
  shelf: (country: string) => [...statuteKeys.all, "shelf", { country }],
  byId: (documentId: string) => [...statuteKeys.all, "detail", documentId],
  asOf: (key: StatuteAsOfKey) => [
    ...statuteKeys.all,
    "asOf",
    { asOf: key.asOf, eli: key.eli, language: key.language },
  ],
  versions: (documentId: string) => [
    ...statuteKeys.all,
    "detail",
    documentId,
    "versions",
  ],
};

export const statutesInfiniteOptions = (filters: StatuteListFilters) =>
  infiniteQueryOptions({
    queryKey: statuteKeys.list(filters),
    queryFn: async ({ pageParam, signal }) => {
      const response = await api.law.statutes.get({
        query: {
          country: filters.country,
          limit: DEFAULT_PAGE_SIZE,
          ...(pageParam !== null && { cursor: pageParam }),
          ...(filters.collection !== undefined && {
            collection: filters.collection,
          }),
          ...(filters.language !== undefined && { language: filters.language }),
          ...(filters.number !== undefined && { number: filters.number }),
          ...(filters.query !== undefined && { query: filters.query }),
        },
        fetch: { signal },
      });

      const data = unwrapPublicLawEden(response, "listPublicStatutes");

      return data;
    },
    initialPageParam: nullableStringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

/**
 * The law home's legislation shelf: what came into force lately and what
 * comes into force next, for one jurisdiction.
 */
export const legislationShelfOptions = (country: string) =>
  queryOptions({
    queryKey: statuteKeys.shelf(country),
    queryFn: async ({ signal }) => {
      const response = await api.law.statutes.shelf.get({
        query: { country },
        fetch: { signal },
      });

      const data = unwrapEden(response);
      assertPublicLawApiData(data, "readPublicLegislationShelf");

      return data;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

/** The legislation shelf as the public reader sees it: both of its sides. */
export type LegislationShelf = Awaited<
  ReturnType<NonNullable<ReturnType<typeof legislationShelfOptions>["queryFn"]>>
>;

const readStatute = async (documentId: string, signal: AbortSignal) => {
  const response = await api.law
    .statutes({ documentId: toSafeId<"legislationDocument">(documentId) })
    .get({ fetch: { signal } });

  const data = unwrapPublicLawEden(response, "readPublicStatute");

  return data;
};

/** One consolidation of a statute, as the public reader sees it. */
export type PublicStatute = Awaited<ReturnType<typeof readStatute>>;

export const statuteOptions = (documentId: string) =>
  queryOptions({
    queryKey: statuteKeys.byId(documentId),
    queryFn: async ({ signal }) => await readStatute(documentId, signal),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

/**
 * The consolidation of a Work that applied on a given date, or null when the
 * corpus covers no version on it. A date outside the covered range is a real
 * answer the reader shows, not a failed request.
 */
export const statuteAsOfOptions = (key: StatuteAsOfKey) =>
  queryOptions({
    queryKey: statuteKeys.asOf(key),
    queryFn: async ({ signal }) => {
      const response = await api.law.statutes["by-eli"].get({
        query: { asOf: key.asOf, eli: key.eli, language: key.language },
        fetch: { signal },
      });

      if (response.error) {
        const error = toPublicLawError(response.error, "readPublicStatuteAsOf");

        if (APIError.is(error) && error.status === NOT_FOUND_STATUS) {
          return null;
        }

        throw error;
      }

      return unwrapPublicLawEden(response, "readPublicStatuteAsOf");
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

type ReadVersionsPageOptions = {
  cursor: string | null;
  documentId: string;
  signal: AbortSignal;
};

const readStatuteVersionsPage = async ({
  cursor,
  documentId,
  signal,
}: ReadVersionsPageOptions) => {
  const response = await api.law
    .statutes({ documentId: toSafeId<"legislationDocument">(documentId) })
    .versions.get({
      query: {
        limit: VERSIONS_PAGE_SIZE,
        ...(cursor === null ? {} : { cursor }),
      },
      fetch: { signal },
    });

  const data = unwrapPublicLawEden(response, "listPublicStatuteVersions");

  return data;
};

type StatuteVersionsPage = Awaited<ReturnType<typeof readStatuteVersionsPage>>;

type ReadVersionsWalkOptions = ReadVersionsPageOptions & {
  collected: StatuteVersionsPage["items"];
  pagesLeft: number;
};

/**
 * A keyset walk is sequential by construction: each request needs the cursor
 * the previous one returned.
 */
const readStatuteVersionsFrom = async ({
  collected,
  cursor,
  documentId,
  pagesLeft,
  signal,
}: ReadVersionsWalkOptions): Promise<StatuteVersionsPage["items"]> => {
  const data = await readStatuteVersionsPage({ cursor, documentId, signal });

  collected.push(...data.items);

  if (data.nextCursor === null) {
    return collected;
  }

  if (pagesLeft <= 1) {
    getAnalytics().captureError(
      new ClientOperationError({
        action: "statutes.versions-walk",
        message: "Statute version walk stopped at the page cap",
      }),
    );

    return collected;
  }

  return await readStatuteVersionsFrom({
    collected,
    cursor: data.nextCursor,
    documentId,
    pagesLeft: pagesLeft - 1,
    signal,
  });
};

/** One entry of a Work's version list. */
export type PublicStatuteVersion = StatuteVersionsPage["items"][number];

/** Every consolidated version of the work, newest window first. */
export const statuteVersionsOptions = (documentId: string) =>
  queryOptions({
    queryKey: statuteKeys.versions(documentId),
    queryFn: async ({ signal }) =>
      await readStatuteVersionsFrom({
        collected: [],
        cursor: null,
        documentId,
        pagesLeft: VERSIONS_MAX_PAGES,
        signal,
      }),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
