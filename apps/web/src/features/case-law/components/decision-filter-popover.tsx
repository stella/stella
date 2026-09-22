import { useId, useState } from "react";

import { ChevronRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { DirectionalIcon } from "@stll/ui/directional-icon";
import { cn } from "@stll/ui/utils";

import { DatePickerPopover } from "@/components/date-picker-popover";
import {
  FACET_SECTION_LIMIT,
  facetSectionView,
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
  YEAR_SECTION_LIMIT,
} from "@/features/case-law/decision-filter-facets.logic";
import type { DecisionFilterFacets } from "@/features/case-law/decision-filter-facets.logic";

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

  return (
    <PublicLawFilterPopover activeFilterCount={activeFilterCount}>
      {facets.courtTiers.length > 0 && (
        <section>
          <FilterSectionHeading>{t("common.court")}</FilterSectionHeading>
          <div className="flex flex-col gap-3">
            {facets.courtTiers.map(({ courts, tier }) => (
              <CourtTierSection
                courts={courts}
                key={tier ?? "untiered"}
                onSelect={(value) => onSelect("court", value)}
                selectedValue={selection.court}
                tier={tier}
              />
            ))}
          </div>
        </section>
      )}
      <DateSection
        buckets={facets.year}
        dateRange={dateRange}
        onDateRangeChange={onDateRangeChange}
      />
      <FacetSection
        buckets={facets.decisionType}
        heading={t("common.type")}
        name="type"
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
      <div className="mt-2 flex flex-col gap-1.5">
        <DateBound
          label={t("search.dateFrom")}
          onChange={(from) => onDateRangeChange({ ...dateRange, from })}
          value={dateRange.from ?? null}
          {...(dateRange.to === undefined ? {} : { maxDate: dateRange.to })}
        />
        <DateBound
          label={t("search.dateTo")}
          onChange={(to) => onDateRangeChange({ ...dateRange, to })}
          value={dateRange.to ?? null}
          {...(dateRange.from === undefined ? {} : { minDate: dateRange.from })}
        />
      </div>
    </section>
  );
};

/** One end of the range: the app's own calendar, labelled as this end. */
const DateBound = ({
  label,
  maxDate,
  minDate,
  onChange,
  value,
}: {
  label: string;
  maxDate?: string;
  minDate?: string;
  onChange: (value: string | undefined) => void;
  value: string | null;
}) => (
  <label className="flex flex-col gap-1">
    <span className="text-muted-foreground text-3xs font-medium tracking-wide uppercase">
      {label}
    </span>
    <DatePickerPopover
      onChange={(next) => onChange(next ?? undefined)}
      value={value}
      {...(maxDate === undefined ? {} : { maxDate })}
      {...(minDate === undefined ? {} : { minDate })}
    />
  </label>
);

const CourtTierSection = ({
  courts,
  onSelect,
  selectedValue,
  tier,
}: {
  courts: readonly FacetSourceBucket[];
  onSelect: (value: string | undefined) => void;
  selectedValue: string | undefined;
  tier: CourtTierBucketsTier;
}) => {
  const t = useTranslations();
  const panelId = useId();
  const collapsedByDefault =
    tier !== null && COLLAPSED_COURT_TIERS.includes(tier);
  const selectedHere = courts.some((court) => court.value === selectedValue);
  const [open, setOpen] = useState(!collapsedByDefault);
  const [showAll, setShowAll] = useState(false);
  const { hiddenCount, items } = facetSectionView({
    buckets: courts,
    expanded: showAll,
    limit: FACET_SECTION_LIMIT,
    // A tier the selection is not in must not pull the selection into itself.
    selectedValue: selectedHere ? selectedValue : undefined,
  });
  if (items.length === 0) {
    return null;
  }
  if (tier === null) {
    return (
      <div>
        <FacetOptions
          groupLabel={t("common.court")}
          items={items}
          name="court"
          onSelect={onSelect}
          selectedValue={selectedValue}
        />
        {hiddenCount > 0 && (
          <ShowAllButton onClick={() => setShowAll(true)}>
            {t("common.showAll")}
          </ShowAllButton>
        )}
      </div>
    );
  }

  // A tier holding the reader's own choice opens whatever its default was.
  const expanded = open || selectedHere;
  return (
    <div>
      <button
        aria-controls={panelId}
        aria-expanded={expanded}
        className="text-foreground-strong-muted hover:text-foreground flex min-h-11 w-full items-center gap-1 py-1 text-start text-xs font-medium transition-colors"
        onClick={() => setOpen(!expanded)}
        type="button"
      >
        <DirectionalIcon
          className={cn(
            "size-3 shrink-0 transition-transform",
            expanded && "rotate-90",
          )}
          flip={!expanded}
          icon={ChevronRightIcon}
        />
        {t(COURT_TIER_LABEL_KEYS[tier])}
      </button>
      <div hidden={!expanded} id={panelId}>
        <FacetOptions
          groupLabel={t(COURT_TIER_LABEL_KEYS[tier])}
          items={items}
          name={`court-${tier}`}
          onSelect={onSelect}
          selectedValue={selectedValue}
        />
        {hiddenCount > 0 && (
          <ShowAllButton onClick={() => setShowAll(true)}>
            {t("common.showAll")}
          </ShowAllButton>
        )}
      </div>
    </div>
  );
};

type CourtTierBucketsTier = DecisionFilterFacets["courtTiers"][number]["tier"];
