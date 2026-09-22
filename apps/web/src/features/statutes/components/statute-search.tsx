import { useTranslations } from "use-intl";

import { PublicLawSearch } from "@/components/public-law-search";
import { useFormatter } from "@/i18n/formatting-context";
import { isStatuteCountry, STATUTE_COUNTRIES } from "@/lib/statute-route";

type StatuteSearchProps = {
  /** The jurisdiction the page is scoped to, as its route segment. */
  country: string;
  maxLength: number;
  onQueryChange: (value: string) => void;
  /** Submitted: open what the entry names, when it names one thing. */
  onSubmit: () => void;
  query: string;
};

/**
 * The statutes browser's instance of the shared public-law box: an act
 * number, an alias or a title. It leads the page the way the case-law box
 * does; the jurisdiction is chosen once, in the top bar. `OZ` is a different
 * act in each jurisdiction, so the chat prompt carries the scope.
 */
export const StatuteSearch = ({
  country,
  maxLength,
  onQueryChange,
  onSubmit,
  query,
}: StatuteSearchProps) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <PublicLawSearch
      askPrompt={(entry) =>
        t("statutes.searchAskPrompt", {
          country: statuteCountryName(format, country),
          query: entry,
        })
      }
      maxLength={maxLength}
      onQueryChange={onQueryChange}
      onSubmit={onSubmit}
      placeholder={t("statutes.searchPlaceholder")}
      query={query}
      searchLabel={t("statutes.searchLabel")}
    />
  );
};

/**
 * A statute jurisdiction as a reader names it, from its route segment. One
 * helper, because the box and the top-bar menu have to say the same country
 * the same way.
 */
export const statuteCountryName = (
  format: ReturnType<typeof useFormatter>,
  segment: string,
): string =>
  format.displayName(
    isStatuteCountry(segment)
      ? STATUTE_COUNTRIES[segment].region
      : segment.toUpperCase(),
    { type: "region" },
  );
