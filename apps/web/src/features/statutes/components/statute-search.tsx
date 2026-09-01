import { useTranslations } from "use-intl";

import { PublicLawSearch } from "@/components/public-law-search";
import { useFormatter } from "@/i18n/formatting-context";
import {
  isStatuteCountry,
  STATUTE_COUNTRIES,
  type StatuteCountry,
} from "@/lib/statute-route";

type StatuteSearchProps = {
  country: string;
  maxLength: number;
  onCountryChange: (country: StatuteCountry) => void;
  onQueryChange: (value: string) => void;
  /** Submitted: open what the entry names, when it names one thing. */
  onSubmit: () => void;
  query: string;
};

/**
 * The statutes browser's instance of the shared public-law box: an act
 * number, an alias or a title, scoped by the jurisdiction pill. `OZ` is a
 * different act in each jurisdiction, so the chat prompt carries the scope.
 */
export const StatuteSearch = ({
  country,
  maxLength,
  onCountryChange,
  onQueryChange,
  onSubmit,
  query,
}: StatuteSearchProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const countryName = (segment: string): string => {
    const region = isStatuteCountry(segment)
      ? STATUTE_COUNTRIES[segment].region
      : segment.toUpperCase();
    return format.displayName(region, { type: "region" });
  };

  return (
    <PublicLawSearch
      askPrompt={(entry) =>
        t("statutes.searchAskPrompt", {
          country: countryName(country),
          query: entry,
        })
      }
      countries={Object.keys(STATUTE_COUNTRIES).map((segment) => ({
        label: countryName(segment),
        value: segment,
      }))}
      country={country}
      maxLength={maxLength}
      onCountryChange={(value) => {
        if (isStatuteCountry(value)) {
          onCountryChange(value);
        }
      }}
      onQueryChange={onQueryChange}
      onSubmit={onSubmit}
      placeholder={t("statutes.searchPlaceholder")}
      query={query}
      searchLabel={t("statutes.searchLabel")}
    />
  );
};
