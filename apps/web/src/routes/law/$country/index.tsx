import { createFileRoute, notFound } from "@tanstack/react-router";
import { panic } from "better-result";

import { createCaseLawJurisdictionHubPath } from "@/features/case-law/browse-hub-path";
import { caseLawBrowseCourtSegment } from "@/features/case-law/browse-path";
import {
  publicCaseLawPageCountryFromParam,
  toCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
import { caseLawBrowseCourtsOptions } from "@/features/case-law/queries/browse-hubs";
import { getFormatter, getTranslator } from "@/i18n/i18n-store";
import { caseLawCountryName } from "@/lib/case-law-route";
import { ensureRouteQueryData } from "@/lib/react-query";
import {
  createPublicLawHubHead,
  type PublicLawHubHeadData,
} from "@/routes/law/-components/public-law-hub-head";

import { JurisdictionHubPage } from "./-index.page";
import { JurisdictionHubPending } from "./-index.pending";

/** Answers the route's not-found page; never returns. */
const missing: () => never = () => {
  notFound({ throw: true });
  return panic("notFound({ throw: true }) returned");
};

/** What the jurisdiction hub's head says, worked out with its reads. */
const jurisdictionHubHead = (
  countryParam: string,
  scope: string,
): PublicLawHubHeadData => {
  const t = getTranslator();
  const country = caseLawCountryName(getFormatter(), scope);
  return {
    description: t("caseLaw.browse.jurisdictionDescription", { country }),
    items: [],
    path: createCaseLawJurisdictionHubPath(countryParam),
    title: t("chat.mention.corpus.caseLaw", { country }),
  };
};

/**
 * A jurisdiction's crawlable hub: every court that holds public decisions,
 * each linking down its browse tree, plus the jurisdiction's statutes. The
 * interactive search home (`/law?country=`) is the same jurisdiction's
 * search, `noindex` with this page as its canonical.
 */
export const Route = createFileRoute("/law/$country/")({
  // The loader and its reads load with the route, not at startup: only the
  // head (and the pending view) stay in the route tree every visit pays for,
  // so the loader also works out what the head says.
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
      head: jurisdictionHubHead(params.country, scope),
    };
  },
  head: ({ loaderData, match }) =>
    createPublicLawHubHead(loaderData?.head, match.search),
  component: JurisdictionHubPage,
  pendingComponent: JurisdictionHubPending,
});
