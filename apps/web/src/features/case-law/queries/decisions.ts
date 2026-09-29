import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { Query, QueryKey } from "@tanstack/react-query";
import { Result } from "better-result";

import type { PublicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";
import {
  SEARCH_TOTAL_NOT_COUNTED,
  type SearchExcerpt,
  type SearchSort,
} from "@stll/api-contract/search";

import {
  DEFAULT_PUBLIC_LAW_PAGE_SIZE,
  type PublicLawPageSize,
} from "@/components/public-law-table/public-law-pagination.logic";
import { api } from "@/lib/api";
import { APIError, unwrapEden } from "@/lib/errors/api";
import { nullableStringCursorSeed } from "@/lib/infinite-query";
import { type PublicLawData, unwrapPublicLawEden } from "@/lib/public-law-api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

/**
 * Legal-vocabulary alternatives for a search's words, as the expansion
 * endpoint answers them and the search accepts them.
 */
type CaseLawQueryAlternatives = NonNullable<
  Parameters<typeof api.case.decisions.search.post>[0]["alternatives"]
>;

export type DecisionListFilters = {
  /**
   * Words ORed in beside the reader's own. Present only when there are some,
   * so a search without them keeps the key the route loader primed.
   */
  alternatives?: CaseLawQueryAlternatives;
  court?: string;
  country: string;
  dateFrom?: string;
  dateTo?: string;
  decisionType?: string;
  /**
   * How much of the matched passage a hit carries. Required rather than
   * defaulted here, so a caller that forgets it cannot silently pin the
   * results to one length; a browse listing carries no passage and ignores it.
   */
  excerpt: SearchExcerpt;
  language?: string;
  search?: string;
  /** How a search orders its hits; absent while there is nothing to rank. */
  sort?: SearchSort;
  /**
   * Require every word the query carries, function words included. Present
   * only when the reader asked for it: the endpoint's default is the lenient
   * search, and sending `false` would claim a choice nobody made.
   */
  strict?: true;
};

/** Root segment every cached read of a public decision shares. */
const DECISION_KEY_ROOT = "case-law-decisions";

const caseLawDecisionKeys = {
  all: [DECISION_KEY_ROOT],
  coverage: () => [...caseLawDecisionKeys.all, "coverage"],
  facets: (country: string | undefined) => [
    ...caseLawDecisionKeys.all,
    "facets",
    { country },
  ],
  latest: (country: string) => [
    ...caseLawDecisionKeys.all,
    "latest",
    { country },
  ],
  status: (country: string) => [
    ...caseLawDecisionKeys.all,
    "status",
    { country },
  ],
  // Total over the key's fields: a filter that reaches the request body
  // cannot be left out of the cache identity, or a result set cached without
  // it would answer a request made with it.
  list: (key: DecisionListKey) => [
    ...caseLawDecisionKeys.all,
    "list",
    {
      alternatives: key.alternatives,
      court: key.court,
      country: key.country,
      dateFrom: key.dateFrom,
      dateTo: key.dateTo,
      decisionType: key.decisionType,
      excerpt: key.excerpt,
      language: key.language,
      pageSize: key.pageSize,
      search: key.search,
      sort: key.sort,
      strict: key.strict,
    } satisfies Record<keyof DecisionListKey, unknown>,
  ],
  byId: (decisionId: string) => [...caseLawDecisionKeys.all, decisionId],
  bySlug: (key: DecisionBySlugKey) => [
    ...caseLawDecisionKeys.all,
    "slug",
    { country: key.country, language: key.language, slug: key.slug },
  ],
};

/**
 * The cache identity of one result set. The page size belongs in it because it
 * is what the cursors in the chain were cut at: the same filters read 25 at a
 * time are a different chain from the same filters read 100 at a time.
 */
type DecisionListKey = DecisionListFilters & { pageSize: PublicLawPageSize };

type DecisionBySlugKey = {
  country: PublicCaseLawCountry;
  language?: string;
  slug: string;
};

/**
 * The facets of one result set, as the search endpoint reports them on the
 * first page. Null on a cursor page: counting again per page would cost a
 * second pass over the same hits for an answer the rail already has.
 */
export type SearchFacets = NonNullable<
  Awaited<
    ReturnType<
      NonNullable<ReturnType<typeof decisionsInfiniteOptions>["queryFn"]>
    >
  >["facets"]
>;

export type CaseLawBrowseFacets = PublicLawData<
  typeof api.case.decisions.facets.get
>;

/** Facets of the whole corpus, or of one jurisdiction when `country` is given. */
export const decisionFacetsOptions = (country: string) =>
  queryOptions({
    queryKey: caseLawDecisionKeys.facets(country),
    queryFn: async ({ signal }) => {
      const response = await api.case.decisions.facets.get({
        query: { country },
        fetch: { signal },
      });

      const data = unwrapPublicLawEden(response, "listPublicCaseLawFacets");

      return data;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

/** The newest decisions of a jurisdiction's largest courts: the browse page's shelf. */
export const latestDecisionsOptions = (country: string) =>
  queryOptions({
    queryKey: caseLawDecisionKeys.latest(country),
    queryFn: async ({ signal }) => {
      const response = await api.case.decisions.latest.get({
        query: { country },
        fetch: { signal },
      });

      const data = unwrapPublicLawEden(
        response,
        "listLatestPublicCaseLawDecisions",
      );

      return data;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

/** How much case law the database holds and when it last changed. */
export const caseLawCorpusStatusOptions = (country: string) =>
  queryOptions({
    queryKey: caseLawDecisionKeys.status(country),
    queryFn: async ({ signal }) => {
      const response = await api.case.decisions.status.get({
        query: { country },
        fetch: { signal },
      });

      const data = unwrapPublicLawEden(
        response,
        "readPublicCaseLawCorpusStatus",
      );

      return data;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

/**
 * How much case law the corpus holds per country and per source, and how
 * fresh each source is. Every country in one read: the page's subject is the
 * whole picture, so there is nothing to scope it to.
 */
export const caseLawCoverageOptions = () =>
  queryOptions({
    queryKey: caseLawDecisionKeys.coverage(),
    queryFn: async ({ signal }) => {
      const response = await api.case.coverage.get({ fetch: { signal } });

      return unwrapPublicLawEden(response, "readPublicCaseLawCoverage");
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

/** One apex court's slice of the shelf: the court, its rank, its newest few. */
export type LatestDecisionsCourt = Awaited<
  ReturnType<NonNullable<ReturnType<typeof latestDecisionsOptions>["queryFn"]>>
>["courts"][number];

export const decisionsInfiniteOptions = (
  filters: DecisionListFilters,
  pageSize: PublicLawPageSize = DEFAULT_PUBLIC_LAW_PAGE_SIZE,
) =>
  infiniteQueryOptions({
    queryKey: caseLawDecisionKeys.list({ ...filters, pageSize }),
    queryFn: async ({ pageParam, signal }) => {
      const { search, ...listFilters } = filters;

      if (search) {
        const cursor = pageParam ?? undefined;
        const response = await api.case.decisions.search.post(
          {
            query: search,
            limit: pageSize,
            ...(cursor !== undefined && { cursor }),
            ...(listFilters.court !== undefined && {
              court: listFilters.court,
            }),
            country: listFilters.country,
            ...(listFilters.dateFrom !== undefined && {
              dateFrom: listFilters.dateFrom,
            }),
            ...(listFilters.dateTo !== undefined && {
              dateTo: listFilters.dateTo,
            }),
            ...(listFilters.decisionType !== undefined && {
              decisionType: listFilters.decisionType,
            }),
            ...(listFilters.language !== undefined && {
              language: listFilters.language,
            }),
            excerpt: listFilters.excerpt,
            ...(listFilters.sort !== undefined && { sort: listFilters.sort }),
            ...(listFilters.strict !== undefined && {
              strict: listFilters.strict,
            }),
            ...(listFilters.alternatives !== undefined && {
              alternatives: listFilters.alternatives,
            }),
          },
          { fetch: { signal } },
        );

        const data = unwrapPublicLawEden(
          response,
          "searchPublicCaseLawDecisions",
        );

        return {
          decisions: data.hits.map((h) => ({
            id: toSafeId<"caseLawDecision">(h.decisionId),
            caseNumber: h.caseNumber,
            caseNumberType: h.caseNumberType,
            slug: h.slug,
            ecli: h.ecli,
            identifiers: h.identifiers,
            court: h.court,
            courtAbbreviation: h.courtAbbreviation,
            courtTier: h.courtTier,
            country: h.country,
            language: h.language,
            languageAlternates: h.languageAlternates,
            decisionDate: h.decisionDate,
            decisionType: h.decisionType,
            sourceUrl: h.sourceUrl,
            headnote: h.headnote,
            headline: h.headline,
            anchorId: h.anchorId,
            citationCount: h.citationCount,
            createdAt: h.createdAt,
          })),
          facets: data.facets,
          nextCursor: data.nextCursor,
          total: data.total,
          // What the search answered, beside what it found: the query it
          // required and what it did not require of the one it was given.
          answered: { queryUsed: data.queryUsed, warnings: data.warnings },
        };
      }

      const response = await api.case.decisions.get({
        query: {
          limit: pageSize,
          ...(pageParam !== null && { cursor: pageParam }),
          ...(listFilters.court !== undefined && {
            court: listFilters.court,
          }),
          country: listFilters.country,
          ...(listFilters.dateFrom !== undefined && {
            dateFrom: listFilters.dateFrom,
          }),
          ...(listFilters.dateTo !== undefined && {
            dateTo: listFilters.dateTo,
          }),
          ...(listFilters.decisionType !== undefined && {
            decisionType: listFilters.decisionType,
          }),
          ...(listFilters.language !== undefined && {
            language: listFilters.language,
          }),
        },
        fetch: { signal },
      });

      const data = unwrapPublicLawEden(response, "listPublicCaseLawDecisions");

      const facets = null;
      const { items, ...page } = data;
      return {
        ...page,
        decisions: items,
        facets,
        total: SEARCH_TOTAL_NOT_COUNTED,
        // A listing answers no query, so there is nothing it could have
        // required less of and nothing to report about it.
        answered: null,
      };
    },
    initialPageParam: nullableStringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

type RefineCaseLawQueryOptions = {
  country: string;
  locale: string;
  query: string;
};

/**
 * The reader's search rewritten by the model into the words the
 * jurisdiction's decisions use. Plain words the case-law search requires,
 * never boolean syntax. Authenticated and metered, unlike the reads above.
 */
export const refineCaseLawQuery = async (body: RefineCaseLawQueryOptions) =>
  unwrapEden(await api.case.decisions.search.refine.post(body));

type CaseLawQueryExpansionOptions = {
  /** The organization whose model and usage answer; part of the identity. */
  activeOrganizationId: string;
  country: string;
  query: string;
  /** Reports a failed expansion; the search then runs as typed. */
  onFailure: (error: unknown) => void;
};

type CaseLawQueryExpansion = Awaited<
  ReturnType<typeof api.case.decisions.search.expand.post>
>["data"];

/** Payment required, forbidden, and over quota: the organization's answer. */
const EXPANSION_DECLINED_STATUSES: ReadonlySet<number> = new Set([
  402, 403, 429,
]);

const DECLINED_EXPANSION = {
  alternatives: [],
  outcome: "none",
} satisfies NonNullable<CaseLawQueryExpansion>;

/** A request that failed on the way: searched as typed, asked again later. */
const DEGRADED_EXPANSION = {
  alternatives: [],
  outcome: "degraded",
} satisfies NonNullable<CaseLawQueryExpansion>;

/**
 * The legal-vocabulary alternatives the model proposes for a search, for a
 * signed-in reader. Held for the session, so every page of one search is
 * asked with the same alternatives the first page was; the server pins them
 * in the cursor either way. A failure is reported and degrades to none: the
 * expansion may widen a search, never stop one.
 */
export const caseLawQueryExpansionOptions = ({
  activeOrganizationId,
  country,
  onFailure,
  query,
}: CaseLawQueryExpansionOptions) =>
  queryOptions({
    queryKey: [
      ...caseLawDecisionKeys.all,
      "expansion",
      { activeOrganizationId, country, query },
    ],
    queryFn: async ({ signal }) => {
      const result = await Result.tryPromise({
        try: async () =>
          unwrapEden(
            await api.case.decisions.search.expand.post(
              { country, query },
              { fetch: { signal } },
            ),
          ),
        catch: (error: unknown) => error,
      });
      if (result.isOk()) {
        return result.value;
      }
      // The organization declining the spend (no grant, no plan, no quota)
      // is an answer, not a fault: settled, unreported, not asked again.
      if (
        APIError.is(result.error) &&
        EXPANSION_DECLINED_STATUSES.has(result.error.status)
      ) {
        return DECLINED_EXPANSION;
      }
      if (!signal.aborted) {
        onFailure(result.error);
      }
      return DEGRADED_EXPANSION;
    },
    // A settled answer holds for the session; a degraded one is asked again
    // the next time the search is, as the server does not cache it either.
    staleTime: ({ state }) =>
      state.data?.outcome === "degraded" ? 0 : Number.POSITIVE_INFINITY,
    retry: false,
  });

export const decisionOptions = (decisionId: string) =>
  queryOptions({
    queryKey: caseLawDecisionKeys.byId(decisionId),
    queryFn: async ({ signal }) => {
      const response = await api.case
        .decisions({ decisionId: toSafeId<"caseLawDecision">(decisionId) })
        .get({ fetch: { signal } });

      const data = unwrapPublicLawEden(response, "readPublicCaseLawDecision");

      return data;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

/**
 * A cache filter matching every read that holds one decision, whichever key
 * brought it in.
 *
 * The id route and the canonical slug route read the same decision under
 * different keys, and the slug key carries the URL's language segment rather
 * than the decision's own, so a read is recognised by the decision it holds
 * instead of by rebuilding a key that may not match.
 */
export const publicDecisionReadFilter = (decisionId: string) => ({
  predicate: (query: Query): boolean =>
    isPublicDecisionReadKey(query.queryKey) &&
    holdsDecision(query.state.data, decisionId),
});

/** Whether a cached key was cut by one of the reads above. */
const isPublicDecisionReadKey = (queryKey: QueryKey): boolean =>
  queryKey.at(0) === DECISION_KEY_ROOT;

/** Whether a cached read resolved to the decision asked about. */
const holdsDecision = (data: unknown, decisionId: string): boolean =>
  typeof data === "object" &&
  data !== null &&
  "id" in data &&
  data.id === decisionId;

export const decisionBySlugOptions = ({
  country,
  language,
  slug,
}: DecisionBySlugKey) =>
  queryOptions({
    queryKey: caseLawDecisionKeys.bySlug(
      language === undefined ? { country, slug } : { country, language, slug },
    ),
    queryFn: async ({ signal }) => {
      const response = await api.case.decisions["by-slug"]({ slug }).get({
        query: {
          country,
          ...(language !== undefined && { language }),
        },
        fetch: { signal },
      });

      const data = unwrapPublicLawEden(
        response,
        "readPublicCaseLawDecisionBySlug",
      );

      return data;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
