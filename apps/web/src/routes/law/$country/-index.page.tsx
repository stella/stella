import { getRouteApi, Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { toCaseLawCountryParam } from "@/features/case-law/case-law-jurisdiction";
import { useFormatter } from "@/i18n/formatting-context";
import { caseLawCountryName } from "@/lib/case-law-route";
import { isPublicStatutePageCountry } from "@/lib/statutes/statute-route";
import {
  CaseLawBrowseLink,
  PublicLawHubItem,
  PublicLawHubSection,
} from "@/routes/law/-components/public-law-hub";
import { PublicLawHubHeader } from "@/routes/law/-components/public-law-hub.pending";

import { JurisdictionHubShell } from "./-index.pending";

const routeApi = getRouteApi("/law/$country/");

/**
 * A jurisdiction's crawlable hub: every court that holds public decisions,
 * each linking down its browse tree, plus the jurisdiction's statutes.
 */
export const JurisdictionHubPage = () => {
  const t = useTranslations();
  const format = useFormatter();
  const { courts, scope } = routeApi.useLoaderData();
  const countryParam = toCaseLawCountryParam(scope);
  const country = caseLawCountryName(format, scope);
  const statuteCountry = countryParam;

  return (
    <JurisdictionHubShell
      header={
        <PublicLawHubHeader
          description={t("caseLaw.browse.jurisdictionDescription", {
            country,
          })}
          title={t("chat.mention.corpus.caseLaw", { country })}
        />
      }
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
    </JurisdictionHubShell>
  );
};
