import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import * as v from "valibot";

import {
  LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_CODE,
  LEGISLATION_WINDOW_DISPOSITION_BASES,
} from "@stll/api-contract/legislation-expression";
import type { LegislationListValidity } from "@stll/api-contract/legislation-status";
import { PUBLIC_STATUTE_SEARCH_PAGE_SIZE_MAX } from "@stll/api-contract/search";

import { DEFAULT_PUBLIC_LAW_PAGE_SIZE } from "@/components/public-law-table/public-law-pagination.logic";
import type { PublicLawPageSize } from "@/components/public-law-table/public-law-pagination.logic";
import type { StatuteWindowGap } from "@/features/statutes/statute-expression";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { ClientOperationError } from "@/lib/errors/client";
import { nullableStringCursorSeed } from "@/lib/infinite-query";
import { isPublicLawMiss, unwrapPublicLawEden } from "@/lib/public-law-api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

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
  /** The kind of act, exactly as the publisher names it (`zákon`). */
  documentType?: string;
  language?: string;
  /** An act number, `<number>/<year>`: the list resolves that work. */
  number?: string;
  query?: string;
  /** Works in force, or works no longer in force; both when absent. */
  validity?: LegislationListValidity;
  year?: string;
};

type StatuteListKey = StatuteListFilters & { pageSize: PublicLawPageSize };

/**
 * A Work addressed the way its public URL addresses it: a jurisdiction and
 * the readable segment, plus the consolidation opening when the URL names
 * one. Absent `asOf` reads the latest consolidation the corpus holds.
 */
export type StatuteSlugKey = {
  asOf?: string;
  country: string;
  slug: string;
};

const statuteKeys = {
  all: ["statutes"],
  list: (key: StatuteListKey) => [
    ...statuteKeys.all,
    "list",
    {
      collection: key.collection,
      country: key.country,
      documentType: key.documentType,
      language: key.language,
      number: key.number,
      pageSize: key.pageSize,
      query: key.query,
      validity: key.validity,
      year: key.year,
    },
  ],
  shelf: (country: string) => [...statuteKeys.all, "shelf", { country }],
  facets: (country: string) => [...statuteKeys.all, "facets", { country }],
  byId: (documentId: string) => [...statuteKeys.all, "detail", documentId],
  publicById: (documentId: string) => [
    ...statuteKeys.all,
    "public-detail",
    documentId,
  ],
  bySlug: (key: StatuteSlugKey) => [
    ...statuteKeys.all,
    "bySlug",
    { asOf: key.asOf, country: key.country, slug: key.slug },
  ],
  versions: (documentId: string) => [
    ...statuteKeys.all,
    "detail",
    documentId,
    "versions",
  ],
};

type ReadStatutesPageOptions = {
  cursor: string | null;
  filters: StatuteListFilters;
  pageSize: PublicLawPageSize;
  signal: AbortSignal;
};

const readStatutesPage = async ({
  cursor,
  filters,
  pageSize,
  signal,
}: ReadStatutesPageOptions) => {
  const response = await api.law.statutes.get({
    query: {
      country: filters.country,
      limit: pageSize,
      ...(cursor !== null && { cursor }),
      ...(filters.collection !== undefined && {
        collection: filters.collection,
      }),
      ...(filters.documentType !== undefined && {
        documentType: filters.documentType,
      }),
      ...(filters.language !== undefined && { language: filters.language }),
      ...(filters.number !== undefined && { number: filters.number }),
      ...(filters.query !== undefined && { query: filters.query }),
      ...(filters.validity !== undefined && { validity: filters.validity }),
      ...(filters.year !== undefined && { year: filters.year }),
    },
    fetch: { signal },
  });

  const data = unwrapPublicLawEden(response, "listPublicStatutes");

  return data;
};

/** One Work as the statute list shows it: its latest wording, summarised. */
export type StatuteListItem = Awaited<
  ReturnType<typeof readStatutesPage>
>["items"][number];

export const statutesInfiniteOptions = (
  filters: StatuteListFilters,
  pageSize: PublicLawPageSize = DEFAULT_PUBLIC_LAW_PAGE_SIZE,
) =>
  infiniteQueryOptions({
    queryKey: statuteKeys.list({ ...filters, pageSize }),
    queryFn: async ({ pageParam, signal }) =>
      await readStatutesPage({
        cursor: pageParam,
        filters,
        pageSize,
        signal,
      }),
    initialPageParam: nullableStringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

/** Public section search stays bounded independently of the Work list. */
const PUBLIC_STATUTE_SEARCH_PAGE_SIZE = PUBLIC_STATUTE_SEARCH_PAGE_SIZE_MAX;

export type StatuteSearchFilters = {
  country: string;
  query: string;
  documentType?: string;
};

const readStatuteSearchPage = async ({
  cursor,
  filters,
  signal,
}: {
  cursor: string | null;
  filters: StatuteSearchFilters;
  signal: AbortSignal;
}) => {
  const response = await api.law.statutes.search.get({
    query: {
      ...filters,
      limit: PUBLIC_STATUTE_SEARCH_PAGE_SIZE,
      ...(cursor === null ? {} : { cursor }),
    },
    fetch: { signal },
  });
  return unwrapPublicLawEden(response, "searchPublicStatutes");
};

export type StatuteSearchHit = Awaited<
  ReturnType<typeof readStatuteSearchPage>
>["items"][number];

export const statuteSearchInfiniteOptions = (filters: StatuteSearchFilters) =>
  infiniteQueryOptions({
    queryKey: [...statuteKeys.all, "full-text", filters],
    queryFn: async ({ pageParam, signal }) =>
      await readStatuteSearchPage({ cursor: pageParam, filters, signal }),
    initialPageParam: nullableStringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

/**
 * The kinds of act a jurisdiction holds, with how many Works each has: the
 * statute list's type filter.
 */
export const statuteFacetsOptions = (country: string) =>
  queryOptions({
    queryKey: statuteKeys.facets(country),
    queryFn: async ({ signal }) => {
      const response = await api.law.statutes.facets.get({
        query: { country },
        fetch: { signal },
      });

      const data = unwrapPublicLawEden(response, "readPublicStatuteFacets");

      return data;
    },
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

      const data = unwrapPublicLawEden(response, "readPublicLegislationShelf");

      return data;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

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
 * The statute a legacy document-id URL names, or null when the corpus no
 * longer holds it. The public reader answers that miss by sending the reader
 * to the law home, so it reads as a value rather than a failure — unlike
 * `statuteOptions`, whose callers render an "unavailable" state instead.
 */
export const publicStatuteOptions = (documentId: string) =>
  queryOptions({
    queryKey: statuteKeys.publicById(documentId),
    queryFn: async ({ signal }) => {
      const response = await api.law
        .statutes({ documentId: toSafeId<"legislationDocument">(documentId) })
        .get({ fetch: { signal } });

      if (
        response.error &&
        isPublicLawMiss(response.error, "readPublicStatute")
      ) {
        return null;
      }

      return unwrapPublicLawEden(response, "readPublicStatute");
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

const windowGapBodySchema = v.object({
  code: v.literal(LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_CODE),
  versions: v.array(
    v.object({
      id: v.string(),
      language: v.string(),
      versionValidFrom: v.nullable(v.string()),
      versionValidTo: v.nullable(v.string()),
      basis: v.nullable(
        v.picklist(Object.values(LEGISLATION_WINDOW_DISPOSITION_BASES).flat()),
      ),
    }),
  ),
});

/**
 * The statute a public URL names, or null when nothing answers to it: an
 * unknown segment, or a date no consolidation of the Work covers. Both are
 * answers the route acts on (not found, or the empty reader), not failures.
 * A date the publisher's inconsistent dates leave unanswered is an answer
 * too, carried with the versions responsible so the reader can say why.
 */
export const statuteBySlugOptions = ({ asOf, country, slug }: StatuteSlugKey) =>
  queryOptions({
    queryKey: statuteKeys.bySlug(
      asOf === undefined ? { country, slug } : { asOf, country, slug },
    ),
    queryFn: async ({ signal }) => {
      const response = await api.law.statutes["by-slug"]({ slug }).get({
        query: { country, ...(asOf === undefined ? {} : { asOf }) },
        fetch: { signal },
      });

      if (
        response.error &&
        isPublicLawMiss(response.error, "readPublicStatuteBySlug")
      ) {
        const gap = v.safeParse(windowGapBodySchema, response.error.value);
        if (!gap.success) {
          return null;
        }
        const windowGap: StatuteWindowGap = { windowGap: gap.output.versions };
        return windowGap;
      }

      return unwrapPublicLawEden(response, "readPublicStatuteBySlug");
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
