import { useTranslations } from "use-intl";

import { PublicLawSearch } from "@/components/public-law-search";
import {
  caseLawCountryRegion,
  fromCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
import { useFormatter } from "@/i18n/formatting-context";

type CaseLawSearchProps = {
  /** The jurisdiction the page is scoped to, as a country param. */
  country: string;
  maxLength: number;
  onQueryChange: (value: string) => void;
  onSubmit: () => void;
  query: string;
};

/**
 * The case-law browser's instance of the shared public-law box: a docket
 * number, an ECLI or words. Dockets repeat across countries, so the chat
 * prompt carries the scope even though the row no longer shows it — the
 * jurisdiction is chosen once, in the top bar.
 */
export const CaseLawSearch = ({
  country,
  maxLength,
  onQueryChange,
  onSubmit,
  query,
}: CaseLawSearchProps) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <PublicLawSearch
      askPrompt={(entry) =>
        t("caseLaw.searchAskPrompt", {
          country: caseLawCountryName(format, fromCaseLawCountryParam(country)),
          query: entry,
        })
      }
      maxLength={maxLength}
      onQueryChange={onQueryChange}
      onSubmit={onSubmit}
      placeholder={t("caseLaw.searchPlaceholder")}
      query={query}
      searchLabel={t("caseLaw.searchLabel")}
    />
  );
};

/**
 * A corpus country as a reader names it. One helper, because the search box,
 * the top-bar menu and the home all have to say the same country the same
 * way.
 */
export const caseLawCountryName = (
  format: ReturnType<typeof useFormatter>,
  code: string,
): string => {
  const region = caseLawCountryRegion(code);
  return region === null
    ? code
    : format.displayName(region, { type: "region" });
};
