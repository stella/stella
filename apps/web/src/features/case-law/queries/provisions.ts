import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { nullableStringCursorSeed } from "@/lib/infinite-query";
import { unwrapPublicLawEden } from "@/lib/public-law-api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

const PROVISIONS_PAGE_SIZE = 50;
/** One work resolves to one act; the extra rows absorb a loose title match. */
const STATUTE_LOOKUP_PAGE_SIZE = 5;
/**
 * Consolidations read in one request, the endpoint's own maximum. An act
 * amended more times than this leaves its oldest versions unread, and a
 * reference to one of those does not link at all: an unresolved version is a
 * missing link, never a link to different wording.
 */
const STATUTE_VERSIONS_PAGE_SIZE = 200;

export const decisionProvisionKeys = {
  all: ["case-law-decisions", "provisions"],
  forDecision: (decisionId: string) => [
    ...decisionProvisionKeys.all,
    decisionId,
  ],
  statuteByEli: (key: StatuteByEliKey) => [
    ...decisionProvisionKeys.all,
    "statute",
    { country: key.country, eli: key.eli },
  ],
  statuteVersions: (documentId: string) => [
    ...decisionProvisionKeys.all,
    "statute",
    documentId,
    "versions",
  ],
};

/** The provisions a decision applies, in the order its text states them. */
export const decisionProvisionsInfiniteOptions = (decisionId: string) =>
  infiniteQueryOptions({
    queryKey: decisionProvisionKeys.forDecision(decisionId),
    queryFn: async ({ pageParam, signal }) => {
      const response = await api.case
        .decisions({ decisionId: toSafeId<"caseLawDecision">(decisionId) })
        .provisions.get({
          query: {
            limit: PROVISIONS_PAGE_SIZE,
            ...(pageParam !== null && { cursor: pageParam }),
          },
          fetch: { signal },
        });

      const data = unwrapPublicLawEden(
        response,
        "listPublicDecisionProvisions",
      );

      return data;
    },
    initialPageParam: nullableStringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export type StatuteByEliKey = {
  /** Jurisdiction of the cited work, which need not be the court's own. */
  country: string;
  eli: string;
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
export const statuteByEliOptions = ({ country, eli }: StatuteByEliKey) =>
  queryOptions({
    queryKey: decisionProvisionKeys.statuteByEli({ country, eli }),
    queryFn: async ({ signal }) => {
      const response = await api.law.statutes.get({
        query: {
          country,
          limit: STATUTE_LOOKUP_PAGE_SIZE,
          query: eli,
        },
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
