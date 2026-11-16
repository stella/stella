import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  caseLawBrowseCourtSegment,
  createCaseLawJurisdictionHubPath,
} from "@/features/case-law/browse-path";
import {
  publicCaseLawPageCountryFromParam,
  toCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
import { caseLawBrowseCourtsOptions } from "@/features/case-law/queries/browse-hubs";
import { useFormatter } from "@/i18n/formatting-context";
import { getFormatter, getTranslator } from "@/i18n/i18n-store";
import { caseLawCountryName } from "@/lib/case-law-route";
import { pageTitleLiteral } from "@/lib/page-title";
import {
  createLegalCollectionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} from "@/lib/public-law-seo";
import { ensureRouteQueryData } from "@/lib/react-query";
import { isPublicStatutePageCountry } from "@/lib/statutes/statute-route";
import {
  CaseLawBrowseLink,
  PublicLawHubItem,
  PublicLawHubLayout,
  PublicLawHubSection,
} from "@/routes/law/-components/public-law-hub";

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
  head: ({ loaderData, params }) => {
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
  component: JurisdictionHub,
});

function JurisdictionHub() {
  const t = useTranslations();
  const format = useFormatter();
  const { courts, scope } = Route.useLoaderData();
  const countryParam = toCaseLawCountryParam(scope);
  const country = caseLawCountryName(format, scope);
  const statuteCountry = countryParam;

  return (
    <PublicLawHubLayout
      description={t("caseLaw.browse.jurisdictionDescription", { country })}
      title={t("chat.mention.corpus.caseLaw", { country })}
    >
      <p className="flex flex-wrap gap-x-4 text-sm">
        <Link
          className="underline underline-offset-2"
          search={{ country: countryParam }}
          to="/law"
        >
          {t("lawHome.searchLabel")}
        </Link>
        {isPublicStatutePageCountry(statuteCountry) ? (
          <Link
            className="underline underline-offset-2"
            params={{ country: statuteCountry }}
            to="/law/$country/statutes"
          >
            {t("statutes.title")}
          </Link>
        ) : null}
      </p>
      <PublicLawHubSection heading={t("caseLaw.browse.courts")}>
        {courts.map(({ name, segment }) => (
          <PublicLawHubItem key={segment}>
            <CaseLawBrowseLink
              countryParam={countryParam}
              target={{ level: "court", court: segment }}
            >
              {name}
            </CaseLawBrowseLink>
          </PublicLawHubItem>
        ))}
      </PublicLawHubSection>
    </PublicLawHubLayout>
  );
}
