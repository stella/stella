import type { ComponentProps } from "react";

import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import type { PublicLawRowsPhase } from "@/components/public-law-table/public-law-results-state.logic";
import { toCaseLawCountryParam } from "@/features/case-law/case-law-jurisdiction";
import { CaseLawNoResults } from "@/features/case-law/components/case-law-no-results";
import { useFormatter } from "@/i18n/formatting-context";
import { caseLawCountryName } from "@/lib/case-law-route";
import type { CaseLawIndexSearch } from "@/routes/law/cases/-case-law-search-schema";

type CaseLawFilterNoticeProps = {
  search: CaseLawIndexSearch;
  country: string;
  onDismiss: () => void;
};

export const CaseLawFilterNotice = ({
  search,
  country,
  onDismiss,
}: CaseLawFilterNoticeProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const removed = search.filterNotice;
  if (removed === undefined || removed.length === 0) {
    return null;
  }

  return (
    <div
      className="bg-muted/40 flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm"
      role="status"
    >
      <p>
        {t("caseLaw.filters.countryMismatch", {
          country: caseLawCountryName(format, country),
          filters: removed.map(({ value }) => value).join(", "),
        })}
      </p>
      {removed.flatMap(({ field, value, countries }) =>
        countries.map((destination) => (
          <Button
            key={`${field}:${destination}`}
            size="sm"
            variant="ghost"
            render={
              <Link
                to="/law/cases"
                search={(previous) => ({
                  ...previous,
                  country: toCaseLawCountryParam(destination),
                  [field]: value,
                  filterNotice: undefined,
                  page: undefined,
                })}
              />
            }
          >
            {t("caseLaw.filters.showInCountry", {
              filter: value,
              country: caseLawCountryName(format, destination),
            })}
          </Button>
        )),
      )}
      <Button size="sm" variant="ghost" onClick={onDismiss}>
        {t("common.dismiss")}
      </Button>
    </div>
  );
};

type CaseLawResultsFeedbackOptions = {
  notice: CaseLawFilterNoticeProps;
  phase: PublicLawRowsPhase;
  resultCount: number;
  unavailable: boolean;
  isTextSearch: boolean;
  noResults: ComponentProps<typeof CaseLawNoResults>;
};

/** A removed-filter explanation occupies the empty table or the results header, once. */
export const caseLawResultsFeedback = ({
  notice,
  phase,
  resultCount,
  unavailable,
  isTextSearch,
  noResults,
}: CaseLawResultsFeedbackOptions) => {
  const emptyState = isTextSearch ? (
    <CaseLawNoResults {...noResults} />
  ) : undefined;
  if (
    notice.search.filterNotice === undefined ||
    notice.search.filterNotice.length === 0
  ) {
    return { aboveResults: null, emptyState };
  }
  const filterNotice = <CaseLawFilterNotice {...notice} />;
  if (phase === "rows" && resultCount === 0 && !unavailable) {
    return { aboveResults: null, emptyState: filterNotice };
  }
  return { aboveResults: filterNotice, emptyState };
};
