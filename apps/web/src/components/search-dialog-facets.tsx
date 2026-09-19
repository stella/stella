import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { CONTROL_SIZE } from "@stll/ui/control-size";
import { Input } from "@stll/ui/input";
import { MenuSection } from "@stll/ui/menu-section";

import { DatePickerPopover } from "@/components/date-picker-popover";
import { rememberSelectedFacetLabels } from "@/components/search-dialog.logic";
import {
  dateInputToIsoEnd,
  dateInputToIsoStart,
  isoToDateInputValue,
  TIME_PRESET_TRANSLATION_KEYS,
} from "@/components/search-dialog.shared";
import type {
  FacetBucket,
  SearchFacetParams,
} from "@/components/search-dialog.shared";
import type { TimeFilter } from "@/components/search-filters.logic";
import { useFormatter } from "@/i18n/formatting-context";
import { searchFacetOptions, TIME_PRESETS } from "@/lib/search";
import type { SearchableFacet, TimePreset } from "@/lib/search";

type FacetGroupProps = {
  title: string;
  buckets: FacetBucket[];
  selected: string[];
  onChange: (value: string) => void;
};

type TimeFacetGroupProps = {
  time: TimeFilter | undefined;
  locale: string;
  onPresetChange: (preset: TimePreset) => void;
  onCustomChange: (range: { updatedFrom?: string; updatedTo?: string }) => void;
  onClearCustom: () => void;
};

export const TimeFacetGroup = ({
  time,
  locale,
  onPresetChange,
  onCustomChange,
  onClearCustom,
}: TimeFacetGroupProps) => {
  const t = useTranslations();
  const isCustom = time?.mode === "custom";
  const customFromValue =
    time?.mode === "custom" && time.updatedFrom
      ? isoToDateInputValue(time.updatedFrom)
      : null;
  const customToValue =
    time?.mode === "custom" && time.updatedTo
      ? isoToDateInputValue(time.updatedTo)
      : null;

  const handleFromChange = (value: string | null) => {
    if (!value) {
      if (!customToValue) {
        onClearCustom();
        return;
      }
      onCustomChange({ updatedTo: dateInputToIsoEnd(customToValue) });
      return;
    }
    onCustomChange({
      updatedFrom: dateInputToIsoStart(value),
      ...(customToValue && { updatedTo: dateInputToIsoEnd(customToValue) }),
    });
  };

  const handleToChange = (value: string | null) => {
    if (!value) {
      if (!customFromValue) {
        onClearCustom();
        return;
      }
      onCustomChange({ updatedFrom: dateInputToIsoStart(customFromValue) });
      return;
    }
    onCustomChange({
      ...(customFromValue && {
        updatedFrom: dateInputToIsoStart(customFromValue),
      }),
      updatedTo: dateInputToIsoEnd(value),
    });
  };

  return (
    <MenuSection title={t("search.updatedWithin")}>
      {TIME_PRESETS.map((preset) => {
        const isActive = time?.mode === "preset" && time.preset === preset;
        return (
          <Button
            key={preset}
            onClick={() => onPresetChange(preset)}
            size="row"
            variant="ghost"
          >
            <Checkbox checked={isActive} tabIndex={-1} />
            <span className="min-w-0 flex-1 truncate">
              {t(TIME_PRESET_TRANSLATION_KEYS[preset])}
            </span>
          </Button>
        );
      })}
      <Button
        onClick={() => {
          if (isCustom) {
            onClearCustom();
          } else {
            onCustomChange({});
          }
        }}
        size="row"
        variant="ghost"
      >
        <Checkbox checked={isCustom} tabIndex={-1} />
        <span className="min-w-0 flex-1 truncate">
          {t("search.timeFilterCustom")}
        </span>
      </Button>
      {isCustom && (
        <div className="space-y-1 px-2">
          <div>
            <p className="text-muted-foreground text-3xs font-medium tracking-wide uppercase">
              {t("search.dateFrom")}
            </p>
            <DatePickerPopover
              layer="search-child"
              locale={locale}
              onChange={handleFromChange}
              value={customFromValue}
              {...(customToValue !== null && { maxDate: customToValue })}
            />
          </div>
          <div>
            <p className="text-muted-foreground text-3xs font-medium tracking-wide uppercase">
              {t("search.dateTo")}
            </p>
            <DatePickerPopover
              layer="search-child"
              locale={locale}
              onChange={handleToChange}
              value={customToValue}
              {...(customFromValue !== null && { minDate: customFromValue })}
            />
          </div>
        </div>
      )}
    </MenuSection>
  );
};

export const FacetGroup = ({
  title,
  buckets,
  selected,
  onChange,
}: FacetGroupProps) => (
  <MenuSection title={title}>
    <FacetBucketList
      buckets={buckets}
      onChange={onChange}
      selected={selected}
    />
  </MenuSection>
);

type FacetBucketListProps = {
  buckets: FacetBucket[];
  selected: string[];
  onChange: (value: string) => void;
};

const FacetBucketList = ({
  buckets,
  selected,
  onChange,
}: FacetBucketListProps) => {
  const format = useFormatter();
  return (
    <>
      {buckets.map((bucket) => (
        <Button
          key={bucket.value}
          onClick={() => onChange(bucket.value)}
          size="row"
          variant="ghost"
        >
          <Checkbox checked={selected.includes(bucket.value)} tabIndex={-1} />
          <span className="min-w-0 flex-1 truncate">
            {bucket.label ?? bucket.value}
          </span>
          <span className="text-muted-foreground tabular-nums">
            {format.number(bucket.count)}
          </span>
        </Button>
      ))}
    </>
  );
};

const FACET_SEARCH_DEBOUNCE_MS = 250;
const FACET_SEARCH_LIMIT = 20;

type SearchableFacetGroupProps = {
  facet: SearchableFacet;
  title: string;
  defaultBuckets: readonly FacetBucket[];
  selected: string[];
  onChange: (value: string) => void;
  searchParams: SearchFacetParams;
  formatLabel?: (bucket: FacetBucket) => string;
};

export const SearchableFacetGroup = ({
  facet,
  title,
  defaultBuckets,
  selected,
  onChange,
  searchParams,
  formatLabel,
}: SearchableFacetGroupProps) => {
  const t = useTranslations();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const debouncedSetSearch = useDebouncedCallback(
    setDebouncedSearch,
    FACET_SEARCH_DEBOUNCE_MS,
  );
  const [selectedLabels, setSelectedLabels] = useState<Record<string, string>>(
    {},
  );
  const isSearching = debouncedSearch.trim().length > 0;
  const { data: searchData } = useQuery({
    ...searchFacetOptions({
      facet,
      search: debouncedSearch,
      limit: FACET_SEARCH_LIMIT,
      ...searchParams,
    }),
    enabled: isSearching && searchParams.enabled,
  });
  const resolveLabel = (bucket: FacetBucket): string =>
    formatLabel ? formatLabel(bucket) : (bucket.label ?? bucket.value);

  const labelsByValue = new Map<string, string>();
  for (const bucket of defaultBuckets) {
    labelsByValue.set(bucket.value, resolveLabel(bucket));
  }
  if (searchData) {
    for (const bucket of searchData.buckets) {
      labelsByValue.set(bucket.value, resolveLabel(bucket));
    }
  }

  const sourceBuckets =
    isSearching && searchData ? searchData.buckets : defaultBuckets;
  const visible: FacetBucket[] = sourceBuckets.map((bucket) => ({
    value: bucket.value,
    count: bucket.count,
    label: resolveLabel(bucket),
  }));
  const present = new Set(visible.map((bucket) => bucket.value));
  const missingSelected: FacetBucket[] = selected.flatMap((id) =>
    present.has(id)
      ? []
      : [
          {
            value: id,
            label: labelsByValue.get(id) ?? selectedLabels[id] ?? id,
            count: 0,
          },
        ],
  );
  const buckets: FacetBucket[] = [...visible, ...missingSelected];
  if (buckets.length === 0 && !isSearching && searchData === undefined) {
    return null;
  }
  return (
    <MenuSection title={title}>
      <Input
        onChange={(event) => {
          const value = event.target.value;
          setSelectedLabels((current) =>
            rememberSelectedFacetLabels(current, selected, labelsByValue),
          );
          setSearch(value);
          debouncedSetSearch(value);
        }}
        placeholder={t("common.search")}
        size={CONTROL_SIZE.sm}
        value={search}
      />
      <FacetBucketList
        buckets={buckets}
        onChange={(value) => {
          setSelectedLabels((current) =>
            rememberSelectedFacetLabels(current, [value], labelsByValue),
          );
          onChange(value);
        }}
        selected={selected}
      />
    </MenuSection>
  );
};
