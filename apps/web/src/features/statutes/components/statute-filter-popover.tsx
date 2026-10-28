import { useId } from "react";

import { useTranslations } from "use-intl";

import { LAW_YEAR_BOUNDS } from "@stll/api-contract/law-year";
import { LEGISLATION_LIST_VALIDITIES } from "@stll/api-contract/legislation-status";
import { NumberInput } from "@stll/ui/number-input";

import type { FacetSourceBucket } from "@/components/public-law-table/public-law-facets.logic";
import {
  FacetSection,
  FilterSectionHeading,
  PublicLawFilterPopover,
} from "@/components/public-law-table/public-law-filter-popover";
import { STATUTE_VALIDITY_LABEL_KEYS } from "@/features/statutes/statute-columns.logic";
import { statuteFilterYear } from "@/features/statutes/statute-filters.logic";
import type { StatuteFilterKey } from "@/features/statutes/statute-filters.logic";
import { useFormattingLocale } from "@/i18n/formatting-context";

type StatuteFilterPopoverProps = {
  /** How many filters are on; drawn on the button, so a short list is explained. */
  activeFilterCount: number;
  onSelect: (key: StatuteFilterKey, value: string | undefined) => void;
  selection: Record<StatuteFilterKey, string | undefined>;
  /** The kinds of act the jurisdiction holds, with how many Works each has. */
  types: readonly FacetSourceBucket[];
};

/** A year as a field shows it: the digits alone, never grouped (`2012`). */
const YEAR_FORMAT = { useGrouping: false } as const;

/**
 * The statute facets in the shared public-law filter popover: whether the act
 * still applies, what kind of act it is, and the year of its number.
 */
export const StatuteFilterPopover = ({
  activeFilterCount,
  onSelect,
  selection,
  types,
}: StatuteFilterPopoverProps) => {
  const t = useTranslations();
  const validities = LEGISLATION_LIST_VALIDITIES.map((validity) => ({
    value: validity,
    label: t(STATUTE_VALIDITY_LABEL_KEYS[validity]),
  }));

  return (
    <PublicLawFilterPopover activeFilterCount={activeFilterCount}>
      <FacetSection
        buckets={validities}
        heading={t("common.status")}
        name="validity"
        onSelect={(value) => onSelect("validity", value)}
        selectedValue={selection.validity}
      />
      <FacetSection
        buckets={types}
        heading={t("common.type")}
        name="type"
        onSelect={(value) => onSelect("type", value)}
        selectedValue={selection.type}
      />
      <YearSection
        onSelect={(value) => onSelect("year", value)}
        selectedValue={selection.year}
      />
    </PublicLawFilterPopover>
  );
};

/**
 * The year in the act's number (`89/2012`), typed rather than picked: a
 * jurisdiction's acts span decades. Applied when the field commits (Enter or
 * leaving it); emptying it clears the year.
 */
const YearSection = ({
  onSelect,
  selectedValue,
}: {
  onSelect: (value: string | undefined) => void;
  selectedValue: string | undefined;
}) => {
  const t = useTranslations();
  const locale = useFormattingLocale();
  const headingId = useId();

  return (
    <section>
      <FilterSectionHeading>
        <span id={headingId}>{t("workspaces.views.calendar.year")}</span>
      </FilterSectionHeading>
      <NumberInput
        // A year set elsewhere (a chip removed, a link) replaces the field's
        // text rather than leaving an edit the URL no longer holds.
        key={selectedValue ?? ""}
        defaultValue={
          selectedValue === undefined ? null : Number(selectedValue)
        }
        format={YEAR_FORMAT}
        inputProps={{ "aria-labelledby": headingId }}
        locale={locale}
        max={LAW_YEAR_BOUNDS.maximum}
        min={LAW_YEAR_BOUNDS.minimum}
        onValueCommitted={(value) => {
          const year = statuteFilterYear(value);
          if (year !== selectedValue) {
            onSelect(year);
          }
        }}
        size="sm"
      />
    </section>
  );
};
