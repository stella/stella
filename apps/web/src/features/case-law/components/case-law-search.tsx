import { useTranslations } from "use-intl";

import { PublicLawSearch } from "@/components/public-law-search";
import {
  CASE_LAW_ALL_COUNTRIES,
  caseLawCountryRegion,
  fromCaseLawCountryParam,
  toCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
import { useFormatter } from "@/i18n/formatting-context";

type CaseLawSearchProps = {
  /** The pill's value: a country param, or `all`. */
  country: string;
  /** Corpus country codes the pill offers, as the facets report them. */
  countries: readonly string[];
  maxLength: number;
  onCountryChange: (country: string) => void;
  onQueryChange: (value: string) => void;
  onSubmit: () => void;
  query: string;
};

/**
 * The case-law browser's instance of the shared public-law box: a docket
 * number, an ECLI or words, scoped by the jurisdiction pill. Dockets repeat
 * across countries, so the chat prompt carries the scope.
 */
export const CaseLawSearch = ({
  countries,
  country,
  maxLength,
  onCountryChange,
  onQueryChange,
  onSubmit,
  query,
}: CaseLawSearchProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const countryName = (code: string): string => {
    const region = caseLawCountryRegion(code);
    return region === null
      ? code
      : format.displayName(region, { type: "region" });
  };

  return (
    <PublicLawSearch
      askPrompt={(entry) =>
        country === CASE_LAW_ALL_COUNTRIES
          ? t("caseLaw.searchAskPromptAll", { query: entry })
          : t("caseLaw.searchAskPrompt", {
              country: countryName(fromCaseLawCountryParam(country)),
              query: entry,
            })
      }
      countries={[
        { label: t("common.all"), value: CASE_LAW_ALL_COUNTRIES },
        ...countries.map((code) => ({
          label: countryName(code),
          value: toCaseLawCountryParam(code),
        })),
      ]}
      country={country}
      maxLength={maxLength}
      onCountryChange={onCountryChange}
      onQueryChange={onQueryChange}
      onSubmit={onSubmit}
      placeholder={t("caseLaw.searchPlaceholder")}
      query={query}
      searchLabel={t("caseLaw.searchLabel")}
    />
  );
};
