import type { QueryClient } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { panic } from "better-result";

import {
  CASE_LAW_BROWSE_MAX_PAGES,
  CASE_LAW_BROWSE_READING_LANGUAGES,
  isCaseLawBrowsePeriodSplit,
} from "@stll/api-contract/case-law-browse-hubs";
import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";

import {
  caseLawBrowseCourtSegment,
  type CaseLawBrowseListing,
  caseLawBrowsePeriodLabel,
  type CaseLawBrowseTarget,
  createCaseLawBrowsePath,
} from "@/features/case-law/browse-path";
import { parseCaseLawBrowseSplat } from "@/features/case-law/browse-path-parse";
import {
  publicCaseLawPageCountryFromParam,
  toCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
import {
  caseLawBrowseCalendarOptions,
  caseLawBrowseCourtsOptions,
  type CaseLawBrowseDecision,
  caseLawBrowseListingOptions,
} from "@/features/case-law/queries/browse-hubs";
import { getFormatter, getTranslator } from "@/i18n/i18n-store";
import { caseLawCountryName } from "@/lib/case-law-route";
import { createPublicLawCanonicalUrl } from "@/lib/public-law-seo";
import { ensureRouteQueryData } from "@/lib/react-query";
import {
  createPublicLawHubHead,
  type PublicLawHubHeadData,
} from "@/routes/law/-components/public-law-hub-head";

import { CourtBrowsePage } from "./-court-browse.page";
import { CourtBrowsePending } from "./-court-browse.pending";

/** Answers the route's not-found page; never returns. */
const missing: () => never = () => {
  notFound({ throw: true });
  return panic("notFound({ throw: true }) returned");
};

type Period = { value: number; count: number };

type BrowsePage =
  | { kind: "periods"; target: CaseLawBrowseTarget; periods: Period[] }
  | {
      kind: "decisions";
      target: CaseLawBrowseListing;
      decisions: CaseLawBrowseDecision[];
      hasNext: boolean;
    };

const readPage = async (
  queryClient: QueryClient,
  country: string,
  court: string,
  target: CaseLawBrowseTarget,
): Promise<BrowsePage> => {
  const listing = async (listed: CaseLawBrowseListing): Promise<BrowsePage> => {
    const page = await ensureRouteQueryData(
      queryClient,
      caseLawBrowseListingOptions({
        country,
        court,
        readingLanguages: CASE_LAW_BROWSE_READING_LANGUAGES,
        target: listed,
      }),
    );
    if (page.items.length === 0) {
      missing();
    }
    return {
      kind: "decisions",
      target: listed,
      decisions: page.items,
      // The last addressable page links no further, even when the period
      // holds more (a busy day): those decisions stay sitemap-only.
      hasNext:
        page.nextCursor !== null && listed.page < CASE_LAW_BROWSE_MAX_PAGES,
    };
  };
  const periods = async (year?: number, month?: number) => {
    const calendar = await ensureRouteQueryData(
      queryClient,
      caseLawBrowseCalendarOptions({
        country,
        court,
        ...(year === undefined ? {} : { year }),
        ...(month === undefined ? {} : { month }),
      }),
    );
    if (calendar.periods.length === 0) {
      missing();
    }
    return calendar.periods;
  };

  switch (target.level) {
    case "court":
      return { kind: "periods", target, periods: await periods() };
    case "year":
      return { kind: "periods", target, periods: await periods(target.year) };
    case "month": {
      const months = await periods(target.year);
      const month = months.find(({ value }) => value === target.month);
      if (month === undefined) {
        missing();
      }
      if (!isCaseLawBrowsePeriodSplit(month.count)) {
        return await listing(target);
      }
      // Too many for one listing: the month lists its days, and has no pages.
      if (target.page > 1) {
        missing();
      }
      return {
        kind: "periods",
        target,
        periods: await periods(target.year, target.month),
      };
    }
    case "day": {
      const months = await periods(target.year);
      const month = months.find(({ value }) => value === target.month);
      // A day page exists only below a month that lists its days.
      if (month === undefined || !isCaseLawBrowsePeriodSplit(month.count)) {
        missing();
      }
      return await listing(target);
    }
    default:
      target satisfies never;
      return panic("Unhandled browse level");
  }
};

/** What a court hub's head says, worked out with the page's reads. */
const courtBrowseHead = ({
  countryParam,
  court,
  page,
  scope,
}: {
  countryParam: string;
  court: string;
  page: BrowsePage;
  scope: string;
}): PublicLawHubHeadData => {
  const t = getTranslator();
  const format = getFormatter();
  const country = caseLawCountryName(format, scope);
  const period = caseLawBrowsePeriodLabel(format, page.target);
  return {
    description:
      period === null
        ? t("caseLaw.browse.courtDescription", { court, country })
        : t("caseLaw.browse.periodDescription", { court, country, period }),
    items:
      page.kind === "decisions"
        ? page.decisions.map((decision) => ({
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
    path: createCaseLawBrowsePath(countryParam, page.target),
    title: period === null ? court : `${court} · ${period}`,
  };
};

export const Route = createFileRoute("/law/$country/courts/$")({
  // The loader and its reads load with the route, not at startup: only the
  // head (and the pending view) stay in the route tree every visit pays for,
  // so the loader also works out what the head says.
  codeSplitGroupings: [["loader"], ["component"]],
  loader: async ({ context: { queryClient }, params }) => {
    const scope = publicCaseLawPageCountryFromParam(params.country);
    const target = parseCaseLawBrowseSplat(params._splat ?? "");
    if (
      scope === null ||
      toCaseLawCountryParam(scope) !== params.country ||
      target === null
    ) {
      missing();
    }
    const { courts } = await ensureRouteQueryData(
      queryClient,
      caseLawBrowseCourtsOptions(scope),
    );
    const court = courts.find(
      (name) => caseLawBrowseCourtSegment(name) === target.court,
    );
    if (court === undefined) {
      missing();
    }
    const page = await readPage(queryClient, scope, court, target);
    return {
      scope,
      court,
      page,
      head: courtBrowseHead({
        countryParam: params.country,
        court,
        page,
        scope,
      }),
    };
  },
  head: ({ loaderData, match }) =>
    createPublicLawHubHead(loaderData?.head, match.search),
  component: CourtBrowsePage,
  pendingComponent: CourtBrowsePending,
});
