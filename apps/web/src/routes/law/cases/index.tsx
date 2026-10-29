import {
  createFileRoute,
  lazyRouteComponent,
  notFound,
  redirect,
} from "@tanstack/react-router";
import { panic, Result, UnhandledException } from "better-result";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import { DEFAULT_SEARCH_EXCERPT } from "@stll/api-contract/search";

import {
  PUBLIC_LAW_SEARCH_STATE,
  publicLawLoadMode,
} from "@/components/public-law-table/public-law-results-state.logic";
import {
  publicLawPageSearchValue,
  publicLawPageSize,
} from "@/components/public-law-table/public-law-route-pagination.logic";
import {
  createCaseLawIndexPath,
  decisionDateRange,
  hasActiveCaseLawFilter,
} from "@/features/case-law/case-law-index-search.logic";
import {
  caseLawCountryScope,
  publicCaseLawCountryFromParam,
  toCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
import {
  caseLawLandingPage,
  caseLawPageEvidence,
  caseLawPageNumber,
} from "@/features/case-law/case-law-route-pages.logic";
import type { Decision } from "@/features/case-law/components/decision-table";
import { prefetchDecisionFacetsAfterSearch } from "@/features/case-law/decision-filter-facets";
import {
  decisionFilterValidationOptions,
  decisionsPageOptions,
} from "@/features/case-law/queries/decisions";
import { getMessageLocale, getTranslator } from "@/i18n/i18n-store";
import { resolveCaseLawRouteCountry } from "@/lib/case-law-route";
import { readQueryResult } from "@/lib/errors/query-result";
import { pageTitle } from "@/lib/page-title";
import {
  isSearchUnavailableError,
  SEARCH_UNAVAILABLE_STATUS,
} from "@/lib/public-law-api";
import {
  createLegalCollectionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} from "@/lib/public-law-seo";
import { ensureRouteQueryData } from "@/lib/react-query";
import { ssrStatusHeaders } from "@/ssr-response-status";

import { correctedCaseLawFilterSearch } from "./-case-law-filter-scope.logic";
import { PublicCaseLawIndexError } from "./-case-law-index-error";
import type { CaseLawIndexSearch } from "./-case-law-search-schema";
import { searchSchema } from "./-case-law-search-schema";

const EMPTY_DECISIONS: readonly Decision[] = [];

/** Which facet a chip belongs to, for the label the chip carries. */
/**
 * The search helpers, fetched when a route hook first needs them rather than
 * with the route: the docket grammars they parse a query with then stay out
 * of the chunks every page preloads. The page component imports them
 * directly, since it already loads on demand.
 */
const loadDecisionSearch = async () =>
  await import("@/features/case-law/open-decision-match");

const createCaseLawIndexDescription = (search: CaseLawIndexSearch): string => {
  const t = getTranslator();
  const range = decisionDateRange(search);
  const scope = [
    search.court,
    caseLawCountryScope(search.country),
    range.from,
    range.to,
  ]
    .filter(Boolean)
    .join(", ");
  if (scope) {
    return t("caseLaw.seo.scopedDescription", { scope });
  }

  return t("caseLaw.seo.description");
};

/**
 * A results read, answering null when the search backend could not be
 * reached. Every other failure is propagated untouched, so the route's error
 * boundary still owns it and still reads the status off the original error;
 * `Result#unwrap` would hand it on wrapped in a `Panic` instead.
 */
const resultsOrOutage = async <TRead,>(
  read: Promise<TRead>,
): Promise<TRead | null> => {
  const result = await Result.tryPromise({
    try: async () => await read,
    // A rejection that is not an `Error` carries no status to classify and no
    // stack to report, so it is named before it travels any further.
    catch: (cause): Error =>
      cause instanceof Error ? cause : new UnhandledException({ cause }),
  });
  return Result.isError(result) && isSearchUnavailableError(result.error)
    ? null
    : readQueryResult(result);
};

/**
 * The rows the document describes: what the crawler reads and what the
 * collection markup lists. Empty while a background load has not produced
 * that page yet, which only a reader with JavaScript ever sees.
 */
const pageDecisions = (
  page: { decisions: readonly Decision[] } | undefined,
): readonly Decision[] => page?.decisions ?? EMPTY_DECISIONS;

export const Route = createFileRoute("/law/cases/")({
  validateSearch: searchSchema,
  // Which questions are drawn, and which words a rewrite replaced, do not
  // change the rows, so neither sends the loader after them again.
  loaderDeps: ({
    search: { questions, rewrite, rewrittenFrom, filterNotice, ...search },
  }) => search,
  // This is a results screen, not an entry screen: with nothing to show
  // results for, the reader belongs on the home. A first visit also starts in
  // the jurisdiction the UI language points at, and the URL says so, so the
  // page and its links agree on the scope. A locale without a matching public
  // country uses the generated list's first entry. Both are server-side
  // redirects because this is a public SSR path: the throw becomes a real
  // HTTP redirect for crawlers and no-JS clients. The blank-page race that
  // no-beforeload-redirect guards against is specific to the client-only
  // _protected subtree.
  beforeLoad: async ({ context: { queryClient }, search }) => {
    const country = resolveCaseLawRouteCountry({
      country: search.country,
      locale: getMessageLocale(),
    });
    if (country === null) {
      notFound({ throw: true });
      return;
    }
    const countryParam = toCaseLawCountryParam(country);

    if (
      search.court !== undefined ||
      search.lang !== undefined ||
      search.type !== undefined ||
      search.sourceId !== undefined
    ) {
      const validation = await ensureRouteQueryData(
        queryClient,
        decisionFilterValidationOptions({
          country,
          court: search.court,
          lang: search.lang,
          type: search.type,
          sourceId: search.sourceId,
        }),
      );
      const correctedSearch = correctedCaseLawFilterSearch({
        search,
        country,
        validation,
      });
      if (correctedSearch !== null) {
        redirect({
          to: "/law/cases",
          search: correctedSearch,
          replace: true,
          throw: true,
        });
      }
    }

    // Only a request that names nothing goes home; a jurisdiction alone is
    // the browse slice the home's country links and the crawler follow.
    if (
      search.q === undefined &&
      search.country === undefined &&
      !hasActiveCaseLawFilter(search)
    ) {
      redirect({
        to: "/law",
        search: { country: countryParam },
        replace: true,
        throw: true,
      });
    }

    // What this URL can actually serve: the jurisdiction spelled the way the
    // links spell it, and a page the results reach. Any page up to the
    // deepest is one request away, so a reload, a shared URL, a new tab and a
    // crawler land on the page they name: a page past the deepest is the
    // deepest, and a page past the results' end is the last that holds rows.
    // One redirect for all of it, so the reader is corrected once.
    const pageSize = publicLawPageSize(search.pageSize);
    const wanted = caseLawPageNumber(search.page, pageSize);
    let reached = wanted;
    const { createDecisionFiltersFromSearch: filtersFromSearch } =
      await loadDecisionSearch();
    const filters = filtersFromSearch(
      { ...search, country: countryParam },
      // The excerpt length lives in the reader's browser, which the router
      // cannot reach here. Priming the default keeps this read on the entry
      // the reader's first page will read when they never changed it.
      { excerpt: DEFAULT_SEARCH_EXCERPT },
    );
    const firstPageOptions = decisionsPageOptions({
      filters,
      page: 1,
      pageSize,
    });
    // Every navigation to a page past the first checks that the page holds
    // rows, a pager step as much as a cold arrival: the count may be an
    // estimate that overstates the results, and an empty table is not a page.
    // A page the pager prefetched is a cache read here; any other is the one
    // request the page needs anyway, and the loader and the rows read it from
    // the cache. The first page comes along for the count the walk back needs.
    if (wanted > 1) {
      const readPage = async (page: number) =>
        await resultsOrOutage(
          ensureRouteQueryData(
            queryClient,
            decisionsPageOptions({ filters, page, pageSize }),
          ),
        );
      const [firstPage] = await Promise.all([
        resultsOrOutage(ensureRouteQueryData(queryClient, firstPageOptions)),
        readPage(wanted),
      ]);
      // An outage proves nothing about which pages exist, so the URL keeps
      // the page the reader linked to: the results region says the search is
      // down, and correcting them to page one would lose the link to a
      // failure that passes.
      if (firstPage !== null) {
        reached = await caseLawLandingPage({
          // An outage, like a page the search could not place, proves nothing.
          evidenceOn: async (page) => {
            const read = await readPage(page);
            return read === null
              ? { type: "unknown" }
              : caseLawPageEvidence(read);
          },
          pageSize,
          total: firstPage.total,
          wanted,
        });
      }
    }
    const page = publicLawPageSearchValue(reached);
    if (search.country !== countryParam || search.page !== page) {
      redirect({
        to: "/law/cases",
        search: { ...search, country: countryParam, page },
        replace: true,
        throw: true,
      });
    }
  },
  loader: async ({ cause, context: { queryClient }, deps }) => {
    const scope =
      publicCaseLawCountryFromParam(deps.country) ??
      panic("The case-law route loaded without a launch-ready country.");
    const { createDecisionFiltersFromSearch: filtersFromSearch } =
      await loadDecisionSearch();
    // The default again: a loader has no browser storage to read the reader's
    // length from, and a reader who never changed it lands on the entry this
    // primes.
    const filters = filtersFromSearch(deps, {
      excerpt: DEFAULT_SEARCH_EXCERPT,
    });
    const pageSize = publicLawPageSize(deps.pageSize);
    const firstPageOptions = decisionsPageOptions({
      filters,
      page: 1,
      pageSize,
    });
    const shownPageOptions = decisionsPageOptions({
      filters,
      page: caseLawPageNumber(deps.page, pageSize),
      pageSize,
    });
    const mode = publicLawLoadMode({
      cause,
      hasCachedPages:
        queryClient.getQueryData(firstPageOptions.queryKey) !== undefined,
    });

    // A filter, a sort or a page step on a page that is already drawn: the
    // toolbar, the headers and the pager are all still correct, so awaiting
    // the new rows here would replace a live page with a skeleton for
    // nothing. The components hold the previous rows and swap them in place.
    if (mode === "background") {
      return {
        decisions: pageDecisions(
          queryClient.getQueryData(shownPageOptions.queryKey),
        ),
        search: PUBLIC_LAW_SEARCH_STATE.answered,
      };
    }

    // The first page describes the result set (its count, its facets) and
    // the page the URL names holds the rows; both are read together, and a
    // deep arrival finds them in the cache `beforeLoad` filled.
    const decisionPages = await prefetchDecisionFacetsAfterSearch({
      country: scope,
      queryClient,
      search: resultsOrOutage(
        Promise.all([
          ensureRouteQueryData(queryClient, firstPageOptions),
          ensureRouteQueryData(queryClient, shownPageOptions),
        ]),
      ),
    });

    // The rows are one region of this page, so a search backend that cannot be
    // reached is that region's failure and not the route's: the box and the
    // filters are the URL's own and stay usable. Every other failure is still
    // the error boundary's.
    if (decisionPages === null) {
      return { decisions: [], search: PUBLIC_LAW_SEARCH_STATE.unavailable };
    }

    const [, shownPage] = decisionPages;
    return {
      decisions: pageDecisions(shownPage),
      search: PUBLIC_LAW_SEARCH_STATE.answered,
    };
  },
  // The document is drawn, but it lists nothing and the results it stands for
  // are still out there. 503 tells a crawler to come back for them instead of
  // recording this page as empty.
  headers: ({ loaderData }) =>
    loaderData?.search === PUBLIC_LAW_SEARCH_STATE.unavailable
      ? ssrStatusHeaders(SEARCH_UNAVAILABLE_STATUS)
      : undefined,
  head: ({ loaderData, match }) => {
    const t = getTranslator();
    const search = match.search;
    const title = pageTitle("common.caseLaw");
    const description = createCaseLawIndexDescription(search);
    const path = createCaseLawIndexPath(search);

    return createPublicLawHead({
      description,
      jsonLd: createLegalCollectionJsonLd({
        t,
        canonicalUrl: createPublicLawCanonicalUrl(path),
        description,
        kind: "caseLaw",
        items: loaderData
          ? loaderData.decisions.map((decision) => ({
              name: decision.caseNumber,
              url: createPublicLawCanonicalUrl(
                createCaseLawDecisionPath(
                  createCaseLawDecisionRouteParams({
                    caseNumber: decision.caseNumber,
                    country: decision.country,
                    court: decision.court,
                    decisionId: decision.id,
                    language: decision.language,
                    languageAlternates: decision.languageAlternates,
                    slug: decision.slug,
                  }),
                ),
              ),
            }))
          : [],
        name: title,
      }),
      path,
      title,
      type: "website",
    });
  },
  // One page, two states. Only a cold arrival renders the pending one — a
  // filter, a sort or a page step keeps the page it is already on — and what
  // waits there is the grid alone: the box, the toolbar, the chips and the
  // pager are the URL's own and are already correct.
  component: lazyRouteComponent(
    async () => import("./-case-law-index-page"),
    "PublicCaseLawIndex",
  ),
  errorComponent: PublicCaseLawIndexError,
  pendingComponent: lazyRouteComponent(
    async () => import("./-case-law-index-page"),
    "PublicCaseLawIndexPending",
  ),
});
