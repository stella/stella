import { useState } from "react";

import { useTranslations } from "use-intl";

import { CourtFilter } from "@stll/ui/court-filter";

import { DateRangeFilter } from "@/components/date-range-filter";
import {
  FACET_SECTION_LIMIT,
  facetSectionView,
  formatFacetCount,
} from "@/components/public-law-table/public-law-facets.logic";
import type { FacetSourceBucket } from "@/components/public-law-table/public-law-facets.logic";
import {
  FacetOptions,
  FacetSection,
  FilterSectionHeading,
  PublicLawFilterPopover,
  ShowAllButton,
} from "@/components/public-law-table/public-law-filter-popover";
import type {
  CaseLawFilterKey,
  DecisionDateRange,
} from "@/features/case-law/case-law-index-search.logic";
import {
  dateRangeYear,
  yearDateRange,
} from "@/features/case-law/case-law-index-search.logic";
import {
  COLLAPSED_COURT_TIERS,
  COURT_TIER_LABEL_KEYS,
  decisionTypeSectionBuckets,
  YEAR_SECTION_LIMIT,
} from "@/features/case-law/decision-filter-facets.logic";
import type {
  DecisionFilterFacets,
  DecisionTypeFacetBucket,
} from "@/features/case-law/decision-filter-facets.logic";
import { useFormatter } from "@/i18n/formatting-context";

/** What the URL selects, one value per facet. */
type DecisionFacetSelection = Record<CaseLawFilterKey, string | undefined>;

type DecisionFilterPopoverProps = {
  /** How many filters are on; drawn on the button, so a short list is explained. */
  activeFilterCount: number;
  /** The decision-date span the URL asks for; either end may be open. */
  dateRange: DecisionDateRange;
  facets: DecisionFilterFacets;
  onDateRangeChange: (range: DecisionDateRange) => void;
  onSelect: (key: CaseLawFilterKey, value: string | undefined) => void;
  selection: DecisionFacetSelection;
};

/**
 * The decision type, each canonical kind in the reader's language. Every entry
 * carries its own label, so the shared section never falls back to drawing a
 * bucket's value.
 */
export const DecisionTypeFacetSection = ({
  buckets,
  onSelect,
  selectedValue,
}: {
  buckets: readonly DecisionTypeFacetBucket[];
  onSelect: (value: string | undefined) => void;
  selectedValue: string | undefined;
}) => {
  const t = useTranslations();
  return (
    <FacetSection
      buckets={decisionTypeSectionBuckets(buckets, selectedValue).map(
        ({ count, labelKey, value }) => ({
          value,
          label: labelKey === null ? value : t(labelKey),
          count,
        }),
      )}
      heading={t("common.type")}
      name="type"
      onSelect={onSelect}
      selectedValue={selectedValue}
    />
  );
};

/**
 * The decision facets in the shared public-law filter popover: courts by
 * tier, the decision date, the type and the language. Every section shows
 * what the current result set actually holds, so a filter can never lead to
 * an empty page.
 */
export const DecisionFilterPopover = ({
  activeFilterCount,
  dateRange,
  facets,
  onDateRangeChange,
  onSelect,
  selection,
}: DecisionFilterPopoverProps) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <PublicLawFilterPopover activeFilterCount={activeFilterCount}>
      {facets.courtTiers.length > 0 && (
        <section>
          <FilterSectionHeading>{t("common.court")}</FilterSectionHeading>
          <CourtFilter
            mode="single"
            collapsedGroups={COLLAPSED_COURT_TIERS}
            visibleRowLimit={FACET_SECTION_LIMIT}
            showAllLabel={t("common.showAll")}
            groups={facets.courtTiers.map(({ courts, tier }) => ({
              value: tier ?? "untiered",
              label: tier === null ? null : t(COURT_TIER_LABEL_KEYS[tier]),
              courts: courts.map((court) => {
                const badgeText =
                  court.count === null || court.count === undefined
                    ? undefined
                    : (formatFacetCount(
                        {
                          ...court,
                          label: court.label ?? court.value,
                          count: court.count,
                        },
                        format.number,
                      ) ?? undefined);
                return {
                  value: court.value,
                  label: court.label ?? court.value,
                  ...(badgeText === undefined ? {} : { badgeText }),
                };
              }),
            }))}
            selected={selection.court}
            onChange={(value) => onSelect("court", value)}
            label={t("common.court")}
          />
        </section>
      )}
      {/* No source (publisher) section: the court filter already says where
          a decision comes from, and the publisher is internal. A link that
          still carries a source keeps working as a removable chip. */}
      <DateSection
        buckets={facets.year}
        dateRange={dateRange}
        onDateRangeChange={onDateRangeChange}
      />
      <DecisionTypeFacetSection
        buckets={facets.decisionType}
        onSelect={(value) => onSelect("type", value)}
        selectedValue={selection.type}
      />
      {/* One language is the corpus's language, not a choice. */}
      {facets.language.length > 1 && (
        <FacetSection
          buckets={facets.language}
          heading={t("common.language")}
          name="lang"
          onSelect={(value) => onSelect("lang", value)}
          selectedValue={selection.lang}
        />
      )}
    </PublicLawFilterPopover>
  );
};

/**
 * When the decision was handed down. A year is the span a reader asks for
 * most, so the list stays — but it is a quick pick for the range below it
 * rather than a filter of its own. The radio shows selected exactly while the
 * range is that year whole, so narrowing either end visibly stops being
 * "2024" and becomes the dates it now is.
 */
const DateSection = ({
  buckets,
  dateRange,
  onDateRangeChange,
}: {
  buckets: readonly FacetSourceBucket[];
  dateRange: DecisionDateRange;
  onDateRangeChange: (range: DecisionDateRange) => void;
}) => {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(false);
  const selectedYear = dateRangeYear(dateRange);
  const { hiddenCount, items } = facetSectionView({
    buckets,
    expanded,
    limit: YEAR_SECTION_LIMIT,
    selectedValue: selectedYear,
  });

  return (
    <section>
      <FilterSectionHeading>{t("common.date")}</FilterSectionHeading>
      {items.length > 0 && (
        <FacetOptions
          groupLabel={t("workspaces.views.calendar.year")}
          items={items}
          name="year"
          onSelect={(value) =>
            onDateRangeChange(value === undefined ? {} : yearDateRange(value))
          }
          selectedValue={selectedYear}
        />
      )}
      {hiddenCount > 0 && (
        <ShowAllButton onClick={() => setExpanded(true)}>
          {t("common.showAll")}
        </ShowAllButton>
      )}
      <DateRangeFilter
        className="mt-2"
        from={dateRange.from ?? null}
        to={dateRange.to ?? null}
        noFuture
        onFromChange={(from) =>
          onDateRangeChange({ ...dateRange, from: from ?? undefined })
        }
        onToChange={(to) =>
          onDateRangeChange({ ...dateRange, to: to ?? undefined })
        }
      />
    </section>
  );
};
