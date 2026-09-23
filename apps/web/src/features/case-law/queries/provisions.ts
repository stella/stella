import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
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
/** One work resolves to one act; the extra rows absorb a loose title match. */
const STATUTE_LOOKUP_PAGE_SIZE = 5;
const ELI_ACT_TAIL_RE =
  /\/(?<collection>[a-z0-9]{1,8})\/(?<year>[0-9]{4})\/(?<number>[0-9]{1,5})\/?$/u;
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
  statuteByEli: (key: StatuteByEliKey) => [
    ...decisionProvisionKeys.all,
    "statute",
    { asOf: key.asOf, country: key.country, eli: key.eli },
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

export type StatuteByEliKey = {
  /** Date whose applicable consolidation must resolve the cited work. */
  asOf: string;
  /** Jurisdiction of the cited work, which need not be the court's own. */
  country: string;
  eli: string;
};

/**
 * Prefer the exact act-number path when an ELI exposes its collection tail.
 * A free-text ELI query ranks `20/1993` ahead of `2/1993`, so a bounded result
 * page can omit the exact work even though the corpus holds it.
 */
const statuteLookupQuery = ({ asOf, country, eli }: StatuteByEliKey) => {
  const match = ELI_ACT_TAIL_RE.exec(eli);
  const collection = match?.groups?.["collection"];
  const year = match?.groups?.["year"];
  const number = match?.groups?.["number"];
  if (collection === undefined || year === undefined || number === undefined) {
    return { asOf, country, limit: STATUTE_LOOKUP_PAGE_SIZE, query: eli };
  }
  return {
    asOf,
    collection,
    country,
    limit: STATUTE_LOOKUP_PAGE_SIZE,
    number: `${number}/${year}`,
  };
};

/**
 * The statute reader's address for a cited work, or null when the corpus
 * does not hold it.
 *
 * A provision reference names a work by its ELI, while the reader is
 * addressed by document: this resolves one to the other, once per work
 * rather than once per reference, and only when a reader opens the panel.
 * The list read matches loosely (it is a search), so the answer is kept only
 * on an exact ELI.
 */
export const statuteByEliOptions = ({ asOf, country, eli }: StatuteByEliKey) =>
  queryOptions({
    queryKey: decisionProvisionKeys.statuteByEli({ asOf, country, eli }),
    queryFn: async ({ signal }) => {
      const response = await api.law.statutes.get({
        query: statuteLookupQuery({ asOf, country, eli }),
        fetch: { signal },
      });

      const data = unwrapPublicLawEden(response, "resolvePublicStatuteByEli");

      return data.items.find((statute) => statute.eli === eli) ?? null;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

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
