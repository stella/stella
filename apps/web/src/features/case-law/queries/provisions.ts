import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { optionalArray } from "@/lib/arrays";
import { nullableStringCursorSeed } from "@/lib/infinite-query";
import { unwrapPublicLawEden } from "@/lib/public-law-api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

const PROVISIONS_PAGE_SIZE = 50;
/** The endpoint's own maximum page. */
const PROVISIONS_LINKING_PAGE_SIZE = 100;
/**
 * Pages read to link a decision's text. A decision citing more provisions
 * than this reads the rest as text rather than holding the reader on an
 * unbounded walk.
 */
const PROVISIONS_LINKING_PAGE_LIMIT = 20;
/**
 * Works resolved in one request, the endpoint's own maximum. A decision citing
 * more is read in several requests at once rather than left partly unlinked.
 */
const STATUTES_RESOLVE_CHUNK_SIZE = 200;
/**
 * Consolidations read in one request, the endpoint's own maximum. An act
 * amended more times than this leaves its oldest versions unread, and a
 * reference to one of those does not link at all: an unresolved version is a
 * missing link, never a link to different wording.
 */
const STATUTE_VERSIONS_PAGE_SIZE = 200;

const decisionProvisionKeys = {
  all: ["case-law-decisions", "provisions"],
  forDecision: (decisionId: string) => [
    ...decisionProvisionKeys.all,
    decisionId,
  ],
  statutesResolve: (works: readonly CitedWorkAtDate[]) => [
    ...decisionProvisionKeys.all,
    "statutes",
    "resolve",
    works.map(({ asOf, country, eli }) => ({ asOf, country, eli })),
  ],
  statuteVersions: (documentId: string) => [
    ...decisionProvisionKeys.all,
    "statute",
    documentId,
    "versions",
  ],
};

const fetchDecisionProvisionsPage = async ({
  cursor,
  decisionId,
  limit,
  signal,
}: {
  cursor: string | null;
  decisionId: string;
  limit: number;
  signal: AbortSignal;
}) => {
  const response = await api.case
    .decisions({ decisionId: toSafeId<"caseLawDecision">(decisionId) })
    .provisions.get({
      query: { limit, ...(cursor !== null && { cursor }) },
      fetch: { signal },
    });

  return unwrapPublicLawEden(response, "listPublicDecisionProvisions");
};

type DecisionProvisionsPage = Awaited<
  ReturnType<typeof fetchDecisionProvisionsPage>
>;

/** The provisions a decision applies, in the order its text states them. */
export const decisionProvisionsInfiniteOptions = (decisionId: string) =>
  infiniteQueryOptions({
    queryKey: decisionProvisionKeys.forDecision(decisionId),
    queryFn: async ({ pageParam, signal }) =>
      await fetchDecisionProvisionsPage({
        cursor: pageParam,
        decisionId,
        limit: PROVISIONS_PAGE_SIZE,
        signal,
      }),
    initialPageParam: nullableStringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

/**
 * Every provision a decision applies, for linking them where the text states
 * them. The panel pages on demand; the text cannot, or a reference past the
 * first page reads as plain text until the panel is expanded.
 */
export const decisionProvisionsForLinkingOptions = (decisionId: string) =>
  queryOptions({
    queryKey: [...decisionProvisionKeys.forDecision(decisionId), "linking"],
    queryFn: async ({ signal }) => {
      const items: DecisionProvisionsPage["items"] = [];
      const previews: DecisionProvisionsPage["previews"] = [];
      let cursor: string | null = null;
      for (let page = 0; page < PROVISIONS_LINKING_PAGE_LIMIT; page += 1) {
        const data = await fetchDecisionProvisionsPage({
          cursor,
          decisionId,
          limit: PROVISIONS_LINKING_PAGE_SIZE,
          signal,
        });
        items.push(...data.items);
        previews.push(...data.previews);
        cursor = data.nextCursor;
        if (cursor === null) {
          break;
        }
      }
      return { items, previews };
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export type CitedWorkAtDate = {
  /** Date whose applicable consolidation must resolve the cited work. */
  asOf: string;
  /** Jurisdiction of the cited work, which need not be the court's own. */
  country: string;
  eli: string;
};

/** The identity a resolved statute is looked up by: the request itself. */
export const citedWorkAtDateKey = ({
  asOf,
  country,
  eli,
}: CitedWorkAtDate): string => `${country}|${eli}|${asOf}`;

const fetchStatutesResolveChunk = async (
  works: readonly CitedWorkAtDate[],
  signal: AbortSignal,
) => {
  const response = await api.law.statutes.resolve.post(
    { works: [...works] },
    { fetch: { signal } },
  );

  return unwrapPublicLawEden(response, "resolvePublicStatutes").items;
};

type ResolvedCitedWork = Awaited<
  ReturnType<typeof fetchStatutesResolveChunk>
>[number];

/** The consolidation a cited work resolved to. */
export type ResolvedCitedStatute = NonNullable<ResolvedCitedWork["statute"]>;

/**
 * The resolved consolidation of each cited work, by `citedWorkAtDateKey`. A
 * work the corpus holds no consolidation of on its date is absent.
 */
export const statuteByCitedWork = (
  resolved: ResolvedCitedWork[] | undefined,
): Map<string, ResolvedCitedStatute> => {
  const statutes = new Map<string, ResolvedCitedStatute>();
  for (const item of optionalArray(resolved)) {
    if (item.statute !== null) {
      statutes.set(citedWorkAtDateKey(item), item.statute);
    }
  }
  return statutes;
};

/**
 * The statute reader's address for every cited work, each at its own date,
 * or null where the corpus holds no consolidation in force then.
 *
 * A provision reference names a work by its ELI, while the reader is
 * addressed by document. Every work a decision cites resolves in one request
 * (one per endpoint maximum past that), so a decision citing dozens of acts
 * links all of them at the cost of one. The works are deduplicated and sorted
 * first, so the same set in any order is the same query.
 */
export const statutesResolveOptions = (works: readonly CitedWorkAtDate[]) => {
  const unique = new Map(
    works.map((work) => [citedWorkAtDateKey(work), work] as const),
  );
  // Keys are unique once deduplicated, so no two compare equal.
  const sorted = [...unique.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([, work]) => work);

  return queryOptions({
    queryKey: decisionProvisionKeys.statutesResolve(sorted),
    queryFn: async ({ signal }) => {
      const chunks: CitedWorkAtDate[][] = [];
      for (
        let start = 0;
        start < sorted.length;
        start += STATUTES_RESOLVE_CHUNK_SIZE
      ) {
        chunks.push(sorted.slice(start, start + STATUTES_RESOLVE_CHUNK_SIZE));
      }
      const answers = await Promise.all(
        chunks.map(
          async (chunk) => await fetchStatutesResolveChunk(chunk, signal),
        ),
      );

      return answers.flat();
    },
    enabled: sorted.length > 0,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
};

/**
 * Every consolidation of the work a document belongs to, newest first.
 *
 * Read only when a reference states a version the current consolidation does
 * not cover: a citation to the wording still in force needs no second read.
 */
export const statuteVersionsOptions = (documentId: string) =>
  queryOptions({
    queryKey: decisionProvisionKeys.statuteVersions(documentId),
    queryFn: async ({ signal }) => {
      const response = await api.law
        .statutes({ documentId: toSafeId<"legislationDocument">(documentId) })
        .versions.get({
          query: { limit: STATUTE_VERSIONS_PAGE_SIZE },
          fetch: { signal },
        });

      const data = unwrapPublicLawEden(
        response,
        "listPublicStatuteVersionsForProvision",
      );

      return data.items;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });
