import { useCallback, useState } from "react";

import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { Input } from "@stll/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";

import { DatePickerPopover } from "@/components/date-picker-popover";
import type {
  DecisionListFilters,
  SearchFacets,
} from "@/features/case-law/queries/decisions";
import { useFormatter } from "@/i18n/formatting-context";

type DecisionFiltersProps = {
  filters: DecisionListFilters;
  onFiltersChange: (filters: DecisionListFilters) => void;
  facets: SearchFacets;
};

/**
 * Matches `updateFilter`'s own normalization exactly: empty becomes
 * `undefined`. Shared so the debounced-write marker (below) can never drift
 * from what actually lands in `filters`.
 */
const normalizeFilterValue = (value: string | null): string | undefined =>
  value || undefined;

/**
 * One-shot marker for the value a debounced writer last pushed up, so the
 * resync-during-render branch can tell that write's echo apart from external
 * navigation. Wrapped in an object because `undefined` is itself a legitimate
 * written value (a cleared field); `null` means "no unconsumed write".
 */
type WrittenMarker = { value: string | undefined } | null;

/**
 * Keeps a local controlled-input value snappy while debouncing an external
 * write, and resyncs from `externalValue` when it changes for a reason other
 * than this hook's own write (e.g. a "browse by court/country" link updating
 * the route without remounting the filter bar).
 *
 * Adjusting state during render: when `externalValue` changes to a value the
 * local mirror has not seen, decide echo vs. external change. The echo of
 * this hook's own debounced write must NOT cancel or reset local state: the
 * user may have resumed typing during the parent re-render gap, and a reset
 * would drop those keystrokes plus their newly-scheduled debounced write.
 * Only a genuinely external change (route navigation) replaces the input.
 * The marker is consumed on every transition so a stale one cannot
 * misclassify a later external change as an echo.
 *
 * `normalize` must match how `writeValue` actually persists the value (e.g.
 * empty string becomes `undefined`). The marker stores the *normalized*
 * written value, so a write whose raw input differs from its persisted form
 * still echoes back equal to the marker instead of being misread as an
 * external change.
 */
const useDebouncedSyncedInput = (
  externalValue: string | undefined,
  writeValue: (value: string) => void,
  normalize: (value: string) => string | undefined,
): [string, (value: string) => void] => {
  const [localValue, setLocalValue] = useState(externalValue ?? "");
  const [lastSeenValue, setLastSeenValue] = useState(externalValue);
  const [lastWrittenValue, setLastWrittenValue] = useState<WrittenMarker>(null);

  const debouncedWrite = useDebouncedCallback((value: string) => {
    setLastWrittenValue({ value: normalize(value) });
    writeValue(value);
  }, 300);

  if (externalValue !== lastSeenValue) {
    setLastSeenValue(externalValue);
    setLastWrittenValue(null);
    if (lastWrittenValue === null || lastWrittenValue.value !== externalValue) {
      debouncedWrite.cancel();
      setLocalValue(externalValue ?? "");
    }
  }

  const onChange = useCallback(
    (value: string) => {
      setLocalValue(value);
      debouncedWrite(value);
    },
    [debouncedWrite],
  );

  return [localValue, onChange];
};

export const DecisionFilters = ({
  filters,
  onFiltersChange,
  facets,
}: DecisionFiltersProps) => {
  const t = useTranslations();
  const format = useFormatter();

  /** Update a single filter key, omitting it when empty. */
  const updateFilter = useCallback(
    (key: keyof DecisionListFilters, value: string | null) => {
      const { [key]: _, ...rest } = filters;
      const trimmed = normalizeFilterValue(value);
      onFiltersChange({
        ...rest,
        ...(trimmed && { [key]: trimmed }),
      });
    },
    [filters, onFiltersChange],
  );

  const handleSearchChange = useDebouncedCallback((value: string) => {
    updateFilter("search", value);
  }, 300);

  const handleCourtSelectChange = useCallback(
    (value: string | null) => {
      updateFilter("court", value);
    },
    [updateFilter],
  );

  const writeCourt = useCallback(
    (value: string) => updateFilter("court", value),
    [updateFilter],
  );
  const [localCourt, handleCourtInputChange] = useDebouncedSyncedInput(
    filters.court,
    writeCourt,
    normalizeFilterValue,
  );

  const handleCountrySelectChange = useCallback(
    (value: string | null) => {
      updateFilter("country", value);
    },
    [updateFilter],
  );

  const writeCountry = useCallback(
    (value: string) => updateFilter("country", value),
    [updateFilter],
  );
  const [localCountry, handleCountryInputChange] = useDebouncedSyncedInput(
    filters.country,
    writeCountry,
    normalizeFilterValue,
  );

  const courtBuckets = facets ? facets.court : [];
  const countryBuckets = facets ? facets.country : [];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        className="max-w-xs"
        defaultValue={filters.search ?? ""}
        onChange={(e) => handleSearchChange(e.currentTarget.value)}
        placeholder={t("caseLaw.filters.searchPlaceholder")}
      />

      {countryBuckets.length > 0 ? (
        <Select
          onValueChange={handleCountrySelectChange}
          value={filters.country ?? ""}
        >
          <SelectTrigger className="w-32">
            <SelectValue placeholder={t("common.country")} />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="">{t("common.all")}</SelectItem>
            {countryBuckets.map((b) => (
              <SelectItem key={b.value} value={b.value}>
                {b.value} ({format.number(b.count)})
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : (
        <Input
          className="max-w-32"
          onChange={(e) => handleCountryInputChange(e.currentTarget.value)}
          placeholder={t("common.country")}
          value={localCountry}
        />
      )}

      {courtBuckets.length > 0 ? (
        <Select
          onValueChange={handleCourtSelectChange}
          value={filters.court ?? ""}
        >
          <SelectTrigger className="w-56">
            <SelectValue placeholder={t("caseLaw.filters.court")} />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="">{t("common.all")}</SelectItem>
            {courtBuckets.map((b) => (
              <SelectItem key={b.value} value={b.value}>
                {b.value} ({format.number(b.count)})
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : (
        <Input
          className="max-w-48"
          onChange={(e) => handleCourtInputChange(e.currentTarget.value)}
          placeholder={t("caseLaw.filters.court")}
          value={localCourt}
        />
      )}

      <DatePickerPopover
        onChange={(v) => updateFilter("dateFrom", v)}
        value={filters.dateFrom ?? ""}
      />
      <DatePickerPopover
        onChange={(v) => updateFilter("dateTo", v)}
        value={filters.dateTo ?? ""}
      />
    </div>
  );
};
