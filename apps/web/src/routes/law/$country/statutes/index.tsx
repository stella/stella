import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

import { statuteDisplayLabel } from "@stll/api-contract/statute-display-label";
import {
  createStatuteIndexPath,
  createStatutePath,
  createStatuteRouteParams,
} from "@stll/api-contract/statute-route";

import {
  publicLawPageNumber,
  publicLawPageSearchValue,
  publicLawPageSize,
  publicLawPagesToWalk,
  reachablePublicLawPage,
} from "@/components/public-law-table/public-law-pagination.logic";
import { statutesInfiniteOptions } from "@/features/statutes/queries/statutes";
import {
  readStatuteIntent,
  type StatutesIndexSearch,
  statutesIndexSearchSchema,
} from "@/features/statutes/statute-index-search.logic";
import { getTranslator } from "@/i18n/i18n-store";
import { pageTitle } from "@/lib/page-title";
import {
  createLegalCollectionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} from "@/lib/public-law-seo";
import { ensureRouteInfiniteQueryData } from "@/lib/react-query";
import { isPublicStatuteCountry } from "@/lib/statutes/statute-route";
import {
  createStatuteListFilters,
  loadPublicStatutesIndex,
} from "@/routes/law/-statutes-index.logic";

import { PublicStatutesIndex } from "./-index.page";
import { PublicStatutesIndexPending } from "./-index.pending";
import { PublicStatutesIndexError } from "./-statutes-index-error";

const createStatutesIndexPath = (
  country: string,
  { q }: StatutesIndexSearch,
): `/law/${string}` => {
  const path = createStatuteIndexPath(country);

  return q ? `${path}?q=${encodeURIComponent(q)}` : path;
};

export const Route = createFileRoute("/law/$country/statutes/")({
  validateSearch: statutesIndexSearchSchema,
  loaderDeps: ({ search }) => search,
  // A page the chain of cursors does not reach redirects to the deepest one
  // that does, as the case-law results do: server-side, so a crawler and a
  // no-JS reader get a real redirect instead of page 3 under a page-40 URL.
  beforeLoad: async ({ context: { queryClient }, params, search }) => {
    if (!isPublicStatuteCountry(params.country)) {
      notFound({ throw: true });
      return;
    }
    if (readStatuteIntent(params.country, search.q).type === "text") {
      return;
    }
    const options = statutesInfiniteOptions(
      createStatuteListFilters(params.country, search),
      publicLawPageSize(search.pageSize),
    );
    const walked =
      queryClient.getQueryData(options.queryKey)?.pages.length ?? 0;
    const wanted = publicLawPageNumber(search.page);
    // Only a deep arrival pays for the walk; the loader decides whether any
    // other navigation is worth awaiting.
    let reached = walked;
    if (wanted > 1 && wanted > walked) {
      const chain = await ensureRouteInfiniteQueryData(queryClient, {
        ...options,
        pages: publicLawPagesToWalk(wanted, walked),
      });
      reached = chain.pages.length;
    }
    const page = publicLawPageSearchValue(
      reachablePublicLawPage(wanted, reached),
    );
    if (search.page !== page) {
      redirect({
        to: "/law/$country/statutes",
        params: { country: params.country },
        search: { ...search, page },
        replace: true,
        throw: true,
      });
    }
  },
  loader: async ({ cause, context: { queryClient }, deps, params }) =>
    await loadPublicStatutesIndex({
      cause,
      country: params.country,
      queryClient,
      search: deps,
    }),
  head: ({ loaderData, match, params }) => {
    const t = getTranslator();
    const title = pageTitle("statutes.title");
    const description = t("statutes.description");
    const path = createStatutesIndexPath(params.country, match.search);

    return createPublicLawHead({
      description,
      indexing: match.search.q === undefined ? "default" : "noindex",
      jsonLd: createLegalCollectionJsonLd({
        t,
        canonicalUrl: createPublicLawCanonicalUrl(path),
        description,
        kind: "statutes",
        items: loaderData
          ? loaderData.statutes.map((statute) => ({
              name: statuteDisplayLabel(statute).text,
              url: createPublicLawCanonicalUrl(
                createStatutePath(
                  createStatuteRouteParams({
                    country: statute.country,
                    documentId: statute.id,
                    eli: statute.eli,
                    slug: statute.slug,
                    version: null,
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
  errorComponent: PublicStatutesIndexError,
  // One page, two states, as the case-law results: only a cold arrival
  // renders the pending one, and what waits there is the page's own shell
  // with its faces and the grid in skeleton.
  component: PublicStatutesIndex,
  pendingComponent: PublicStatutesIndexPending,
});
