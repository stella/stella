import { getRouteApi, Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { isCaseLawBrowsePeriodSplit } from "@stll/api-contract/case-law-browse-hubs";
import { createCaseLawDecisionRouteParams } from "@stll/api-contract/case-law-decision-route";

import {
  caseLawBrowseMonthLabel,
  caseLawBrowsePeriodLabel,
  type CaseLawBrowseTarget,
} from "@/features/case-law/browse-path";
import { toCaseLawCountryParam } from "@/features/case-law/case-law-jurisdiction";
import {
  decisionLinkElement,
  formatDecisionDate,
} from "@/features/case-law/components/decision-cells";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { caseLawCountryName } from "@/lib/case-law-route";
import {
  CaseLawBrowseLink,
  CaseLawBrowsePager,
  PublicLawHubCrumbs,
  PublicLawHubHeader,
  PublicLawHubItem,
  PublicLawHubScroll,
  PublicLawHubSection,
} from "@/routes/law/-components/public-law-hub";

import { CourtBrowseShell } from "./-court-browse.pending";

const routeApi = getRouteApi("/law/$country/courts/$");

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

export const CourtBrowsePage = () => {
  const t = useTranslations();
  const format = useFormatter();
  const { court, page, scope } = routeApi.useLoaderData();
  const countryParam = toCaseLawCountryParam(scope);
  const country = caseLawCountryName(format, scope);
  const { target } = page;
  const period = caseLawBrowsePeriodLabel(format, target);
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
                {caseLawBrowseMonthLabel(format, target.year, target.month)}
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
    <PublicLawHubScroll>
      <CourtBrowseShell
        crumbs={<PublicLawHubCrumbs items={crumbs} />}
        header={
          <PublicLawHubHeader
            description={
              period === null
                ? t("caseLaw.browse.courtDescription", { court, country })
                : t("caseLaw.browse.periodDescription", {
                    court,
                    country,
                    period,
                  })
            }
            title={period === null ? court : `${court} · ${period}`}
          />
        }
      >
        {page.kind === "periods" ? (
          <PublicLawHubSection heading={t(PERIOD_HEADING_KEYS[target.level])}>
            {page.periods.map(({ count, value }) => {
              const next = childTarget(target, value);
              return (
                <PublicLawHubItem key={value} meta={countLabel(count)}>
                  <CaseLawBrowseLink countryParam={countryParam} target={next}>
                    {caseLawBrowsePeriodLabel(format, next) ?? String(value)}
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
      </CourtBrowseShell>
    </PublicLawHubScroll>
  );
};
