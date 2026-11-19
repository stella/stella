import { createFileRoute, notFound } from "@tanstack/react-router";
import { panic } from "better-result";

import {
  caseLawBrowseCourtSegment,
  createCaseLawJurisdictionHubPath,
  hasSearch,
} from "@/features/case-law/browse-path";
import {
  publicCaseLawPageCountryFromParam,
  toCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
import { caseLawBrowseCourtsOptions } from "@/features/case-law/queries/browse-hubs";
import { getFormatter, getTranslator } from "@/i18n/i18n-store";
import { caseLawCountryName } from "@/lib/case-law-route";
import { pageTitleLiteral } from "@/lib/page-title";
import {
  createLegalCollectionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} from "@/lib/public-law-seo";
import { ensureRouteQueryData } from "@/lib/react-query";

import { JurisdictionHubPage } from "./-index.page";
import { JurisdictionHubPending } from "./-index.pending";

/** Answers the route's not-found page; never returns. */
const missing: () => never = () => {
  notFound({ throw: true });
  return panic("notFound({ throw: true }) returned");
};

/**
 * A jurisdiction's crawlable hub: every court that holds public decisions,
 * each linking down its browse tree, plus the jurisdiction's statutes. The
 * interactive search home (`/law?country=`) is the same jurisdiction's
 * search, `noindex` with this page as its canonical.
 */
export const Route = createFileRoute("/law/$country/")({
  // The loader and its reads load with the route, not at startup: only the
  // head (and the pending view) stay in the route tree every visit pays for.
  codeSplitGroupings: [["loader"], ["component"]],
  loader: async ({ context: { queryClient }, params }) => {
    const scope = publicCaseLawPageCountryFromParam(params.country);
    if (scope === null || toCaseLawCountryParam(scope) !== params.country) {
      missing();
    }
    const { courts } = await ensureRouteQueryData(
      queryClient,
      caseLawBrowseCourtsOptions(scope),
    );
    // One hub per URL segment: spellings that fold to one segment share it.
    const bySegment = new Map<string, string>();
    for (const court of courts) {
      const segment = caseLawBrowseCourtSegment(court);
      if (!bySegment.has(segment)) {
        bySegment.set(segment, court);
      }
    }
    return {
      scope,
      courts: [...bySegment].map(([segment, name]) => ({ segment, name })),
    };
  },
  head: ({ loaderData, match, params }) => {
    const t = getTranslator();
    const country = caseLawCountryName(
      getFormatter(),
      loaderData?.scope ?? params.country,
    );
    const title = t("chat.mention.corpus.caseLaw", { country });
    const description = t("caseLaw.browse.jurisdictionDescription", {
      country,
    });
    const path = createCaseLawJurisdictionHubPath(params.country);
    return createPublicLawHead({
      // Any query string makes this a variant of the hub, never the hub;
      // the variant's canonical link names the hub.
      indexing: hasSearch(match.search) ? "noindex" : "default",
      canonicalPath: path,
      description,
      jsonLd: createLegalCollectionJsonLd({
        t,
        canonicalUrl: createPublicLawCanonicalUrl(path),
        description,
        kind: "caseLaw",
        name: title,
      }),
      path,
      title: pageTitleLiteral(title),
      type: "website",
    });
  },
  component: JurisdictionHubPage,
  pendingComponent: JurisdictionHubPending,
});
