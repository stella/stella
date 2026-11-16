import type { QueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  CASE_LAW_BROWSE_READING_LANGUAGES,
  isCaseLawBrowsePeriodSplit,
} from "@stll/api-contract/case-law-browse-hubs";
import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import { Temporal } from "@stll/time";

import {
  caseLawBrowseCourtSegment,
  type CaseLawBrowseListing,
  type CaseLawBrowseTarget,
  createCaseLawBrowsePath,
  parseCaseLawBrowseSplat,
} from "@/features/case-law/browse-path";
import {
  publicCaseLawPageCountryFromParam,
  toCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
import {
  decisionLinkElement,
  formatDecisionDate,
} from "@/features/case-law/components/decision-cells";
import {
  caseLawBrowseCalendarOptions,
  caseLawBrowseCourtsOptions,
  type CaseLawBrowseDecision,
  caseLawBrowseListingOptions,
} from "@/features/case-law/queries/browse-hubs";
import { useFormatter } from "@/i18n/formatting-context";
import { getFormatter, getTranslator } from "@/i18n/i18n-store";
import type { TranslationKey } from "@/i18n/types";
import { caseLawCountryName } from "@/lib/case-law-route";
import { pageTitleLiteral } from "@/lib/page-title";
import {
  createLegalCollectionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} from "@/lib/public-law-seo";
import { ensureRouteQueryData } from "@/lib/react-query";
import {
  CaseLawBrowseLink,
  CaseLawBrowsePager,
  PublicLawHubCrumbs,
  PublicLawHubItem,
  PublicLawHubLayout,
  PublicLawHubSection,
} from "@/routes/law/-components/public-law-hub";

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
      hasNext: page.nextCursor !== null,
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

export const Route = createFileRoute("/law/$country/courts/$")({
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
    return {
      scope,
      court,
      page: await readPage(queryClient, scope, court, target),
    };
  },
  head: ({ loaderData, params }) => {
    if (loaderData === undefined) {
      return {};
    }
    const t = getTranslator();
    const format = getFormatter();
    const { court, page, scope } = loaderData;
    const country = caseLawCountryName(format, scope);
    const period = periodLabel(format, page.target);
    const title = period === null ? court : `${court} · ${period}`;
    const description =
      period === null
        ? t("caseLaw.browse.courtDescription", { court, country })
        : t("caseLaw.browse.periodDescription", { court, country, period });
    const path = createCaseLawBrowsePath(params.country, page.target);
    return createPublicLawHead({
      description,
      jsonLd: createLegalCollectionJsonLd({
        t,
        canonicalUrl: createPublicLawCanonicalUrl(path),
        description,
        kind: "caseLaw",
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
        name: title,
      }),
      path,
      title: pageTitleLiteral(title),
      type: "website",
    });
  },
  component: CourtBrowsePage,
});

type Formatter = ReturnType<typeof getFormatter>;

/** A calendar day as the instant its UTC midnight is, for the formatter. */
const utcDay = (year: number, month: number, day = 1): number =>
  Temporal.PlainDate.from({ year, month, day }).toZonedDateTime("UTC")
    .epochMilliseconds;

const monthLabel = (format: Formatter, year: number, month: number) =>
  format.dateTime(utcDay(year, month), {
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  });

/** What a level lists below it, as its section heading names it. */
const PERIOD_HEADING_KEYS = {
  court: "workspaces.views.calendar.year",
  year: "workspaces.views.calendar.month",
  month: "caseLaw.browse.days",
  day: "caseLaw.browse.days",
} as const satisfies Record<CaseLawBrowseTarget["level"], TranslationKey>;

/** The page one period of `target`'s listing links to. */
const childTarget = (
  target: CaseLawBrowseTarget,
  value: number,
): CaseLawBrowseTarget => {
  switch (target.level) {
    case "court":
      return { level: "year", court: target.court, year: value };
    case "year":
      return {
        level: "month",
        court: target.court,
        year: target.year,
        month: value,
        page: 1,
      };
    case "month":
      return {
        level: "day",
        court: target.court,
        year: target.year,
        month: target.month,
        day: value,
        page: 1,
      };
    case "day":
      return panic("A day lists decisions, not periods");
    default:
      target satisfies never;
      return panic("Unhandled browse level");
  }
};

/** The period a page covers, as the page's language names it. */
const periodLabel = (
  format: Formatter,
  target: CaseLawBrowseTarget,
): string | null => {
  switch (target.level) {
    case "court":
      return null;
    case "year":
      return String(target.year);
    case "month":
      return monthLabel(format, target.year, target.month);
    case "day":
      return format.dateTime(utcDay(target.year, target.month, target.day), {
        dateStyle: "long",
        timeZone: "UTC",
      });
    default:
      target satisfies never;
      return panic("Unhandled browse level");
  }
};

function CourtBrowsePage() {
  const t = useTranslations();
  const format = useFormatter();
  const { court, page, scope } = Route.useLoaderData();
  const countryParam = toCaseLawCountryParam(scope);
  const country = caseLawCountryName(format, scope);
  const { target } = page;
  const period = periodLabel(format, target);
  const segment = target.court;

  const crumbs = [
    {
      key: "country",
      link: (
        <Link
          className="underline-offset-2 hover:underline"
          params={{ country: countryParam }}
          to="/law/$country"
        >
          {t("chat.mention.corpus.caseLaw", { country })}
        </Link>
      ),
    },
    ...(target.level === "court"
      ? []
      : [
          {
            key: "court",
            link: (
              <CaseLawBrowseLink
                countryParam={countryParam}
                target={{ level: "court", court: segment }}
              >
                {court}
              </CaseLawBrowseLink>
            ),
          },
        ]),
    ...(target.level === "month" || target.level === "day"
      ? [
          {
            key: "year",
            link: (
              <CaseLawBrowseLink
                countryParam={countryParam}
                target={{ level: "year", court: segment, year: target.year }}
              >
                {String(target.year)}
              </CaseLawBrowseLink>
            ),
          },
        ]
      : []),
    ...(target.level === "day"
      ? [
          {
            key: "month",
            link: (
              <CaseLawBrowseLink
                countryParam={countryParam}
                target={{
                  level: "month",
                  court: segment,
                  year: target.year,
                  month: target.month,
                  page: 1,
                }}
              >
                {monthLabel(format, target.year, target.month)}
              </CaseLawBrowseLink>
            ),
          },
        ]
      : []),
  ];

  const countLabel = (count: number) =>
    isCaseLawBrowsePeriodSplit(count) || count === 0
      ? null
      : t("caseLaw.citation.decisionCount", { count });

  return (
    <PublicLawHubLayout
      crumbs={<PublicLawHubCrumbs items={crumbs} />}
      description={
        period === null
          ? t("caseLaw.browse.courtDescription", { court, country })
          : t("caseLaw.browse.periodDescription", { court, country, period })
      }
      title={period === null ? court : `${court} · ${period}`}
    >
      {page.kind === "periods" ? (
        <PublicLawHubSection heading={t(PERIOD_HEADING_KEYS[target.level])}>
          {page.periods.map(({ count, value }) => {
            const next = childTarget(target, value);
            return (
              <PublicLawHubItem key={value} meta={countLabel(count)}>
                <CaseLawBrowseLink countryParam={countryParam} target={next}>
                  {periodLabel(format, next) ?? String(value)}
                </CaseLawBrowseLink>
              </PublicLawHubItem>
            );
          })}
        </PublicLawHubSection>
      ) : (
        <>
          <PublicLawHubSection heading={t("common.decisions")}>
            {page.decisions.map((decision) => (
              <PublicLawHubItem
                key={decision.id}
                meta={
                  decision.decisionDate === null
                    ? decision.decisionType
                    : [
                        formatDecisionDate(decision.decisionDate, format),
                        decision.decisionType,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                }
              >
                {decisionLinkElement({
                  children: decision.caseNumber,
                  className:
                    "inline-flex min-h-11 items-center px-2 text-sm underline-offset-2 hover:underline",
                  params: createCaseLawDecisionRouteParams({
                    caseNumber: decision.caseNumber,
                    country: decision.country,
                    court: decision.court,
                    decisionId: decision.id,
                    language: decision.language,
                    languageAlternates: decision.languageAlternates,
                    slug: decision.slug,
                  }),
                })}
              </PublicLawHubItem>
            ))}
          </PublicLawHubSection>
          <CaseLawBrowsePager
            countryParam={countryParam}
            hasNext={page.hasNext}
            target={page.target}
          />
        </>
      )}
    </PublicLawHubLayout>
  );
}
