import type { ReactNode } from "react";
import { useId, useState } from "react";

import { ChevronRightIcon, SlidersHorizontalIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import {
  Popover,
  PopoverPanel,
  PopoverTitle,
  PopoverTrigger,
} from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import { DatePickerPopover } from "@/components/date-picker-popover";
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
  FACET_SECTION_LIMIT,
  facetSectionView,
  YEAR_SECTION_LIMIT,
} from "@/features/case-law/decision-filter-facets.logic";
import type {
  DecisionFilterFacets,
  FacetItem,
  FacetSourceBucket,
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
 * Refinement behind one button, so the results keep the width and the search
 * box keeps the page. Every section shows what the current result set
 * actually holds, so a filter can never lead to an empty page, and the
 * reader's own choice stays visible even once the counts stop reporting it.
 *
 * Nothing here is only in the popover: the button carries the count and the
 * chips under the box name each filter and take it back out, so a reader who
 * never opens this still knows what narrows the list.
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
    <Popover>
      <PopoverTrigger
        render={<Button className="shrink-0" size="sm" variant="outline" />}
      >
        <SlidersHorizontalIcon aria-hidden="true" className="size-3.5" />
        {t("common.filters")}
        {activeFilterCount > 0 && (
          <span className="bg-primary text-primary-foreground inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-medium tabular-nums">
            {format.number(activeFilterCount)}
          </span>
        )}
      </PopoverTrigger>
      <PopoverPanel
        align="start"
        className="w-72 max-w-[calc(100vw-2rem)]"
        contentClassName="gap-5"
      >
        {/* The trigger names the button, not the portaled popup. */}
        <PopoverTitle className="sr-only">{t("common.filters")}</PopoverTitle>
        <FacetSections
          dateRange={dateRange}
          facets={facets}
          onDateRangeChange={onDateRangeChange}
          onSelect={onSelect}
          selection={selection}
        />
      </PopoverPanel>
    </Popover>
  );
};

const FacetSections = ({
  dateRange,
  facets,
  onDateRangeChange,
  onSelect,
  selection,
}: Omit<DecisionFilterPopoverProps, "activeFilterCount">) => {
  const t = useTranslations();

  return (
    <>
      {facets.courtTiers.length > 0 && (
        <section>
          <SectionHeading>{t("common.court")}</SectionHeading>
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
        filterKey="type"
        heading={t("common.type")}
        limit={FACET_SECTION_LIMIT}
        onSelect={onSelect}
        selectedValue={selection.type}
      />
      {/* One language is the corpus's language, not a choice. */}
      {facets.language.length > 1 && (
        <FacetSection
          buckets={facets.language}
          filterKey="lang"
          heading={t("common.language")}
          limit={FACET_SECTION_LIMIT}
          onSelect={onSelect}
          selectedValue={selection.lang}
        />
      )}
    </>
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
      <SectionHeading>{t("common.date")}</SectionHeading>
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
    <span className="text-muted-foreground text-[0.625rem] font-medium tracking-wide uppercase">
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

const SectionHeading = ({ children }: { children: ReactNode }) => (
  <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
    {children}
  </h3>
);

type FacetSectionProps = {
  buckets: readonly FacetSourceBucket[];
  filterKey: CaseLawFilterKey;
  /**
   * Already translated. A `TranslationKey` prop would hand `t()` the whole
   * key union at this call site, which costs more to instantiate than the
   * section is worth.
   */
  heading: string;
  limit: number;
  onSelect: (key: CaseLawFilterKey, value: string | undefined) => void;
  selectedValue: string | undefined;
};

const FacetSection = ({
  buckets,
  filterKey,
  heading,
  limit,
  onSelect,
  selectedValue,
}: FacetSectionProps) => {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(false);
  const { hiddenCount, items } = facetSectionView({
    buckets,
    expanded,
    limit,
    selectedValue,
  });
  if (items.length === 0) {
    return null;
  }

  return (
    <section>
      <SectionHeading>{heading}</SectionHeading>
      <FacetOptions
        groupLabel={heading}
        items={items}
        name={filterKey}
        onSelect={(value) => onSelect(filterKey, value)}
        selectedValue={selectedValue}
      />
      {hiddenCount > 0 && (
        <ShowAllButton onClick={() => setExpanded(true)}>
          {t("common.showAll")}
        </ShowAllButton>
      )}
    </section>
  );
};

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

const ShowAllButton = ({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) => (
  <button
    className="text-muted-foreground hover:text-foreground -mx-1 min-h-11 px-1 py-1.5 text-xs transition-colors"
    onClick={onClick}
    type="button"
  >
    {children}
  </button>
);

/**
 * One choice out of a section. Native radios, so the group is a group to a
 * screen reader and arrow keys move through it without a roving-tabindex
 * imitation; clicking the chosen one again clears the filter, which a radio
 * group alone cannot express.
 */
const FacetOptions = ({
  groupLabel,
  items,
  name,
  onSelect,
  selectedValue,
}: {
  groupLabel: string;
  items: readonly FacetItem[];
  name: string;
  onSelect: (value: string | undefined) => void;
  selectedValue: string | undefined;
}) => {
  const format = useFormatter();

  return (
    <ul aria-label={groupLabel} className="flex flex-col">
      {items.map((item) => {
        const checked = item.value === selectedValue;
        return (
          <li key={item.value}>
            <label className="hover:bg-muted/60 has-[:focus-visible]:ring-ring flex min-h-11 cursor-pointer items-center gap-2 rounded-sm py-1.5 ps-1 pe-1 text-xs transition-colors has-[:focus-visible]:ring-2">
              <input
                checked={checked}
                className="accent-primary size-3.5 shrink-0"
                name={name}
                onChange={() => onSelect(item.value)}
                onClick={() => {
                  if (checked) {
                    onSelect(undefined);
                  }
                }}
                type="radio"
                value={item.value}
              />
              <BidiText
                as="span"
                className={cn(
                  "min-w-0 flex-1 truncate",
                  checked ? "text-foreground font-medium" : "text-foreground",
                )}
                title={item.label}
              >
                {item.label}
              </BidiText>
              {item.count !== null && (
                <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                  {format.number(item.count)}
                </span>
              )}
            </label>
          </li>
        );
      })}
    </ul>
  );
};
