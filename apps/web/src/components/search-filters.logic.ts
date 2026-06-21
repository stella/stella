import type { GlobalSearchResultType } from "@stll/api/types";

import { presetUpdatedFrom } from "@/lib/search";
import type { TimePreset } from "@/lib/search";

export type TimeFilter =
  | { mode: "preset"; preset: TimePreset }
  | { mode: "custom"; updatedFrom?: string; updatedTo?: string };

export type SearchFilters = {
  workspaceIds: string[];
  types: GlobalSearchResultType[];
  editedByUserIds: string[];
  mimeTypes: string[];
  time?: TimeFilter;
};

export const resolveUpdatedFrom = (
  time: TimeFilter | undefined,
): string | undefined => {
  if (time?.mode === "preset") {
    return presetUpdatedFrom(time.preset);
  }
  if (time?.mode === "custom") {
    return time.updatedFrom;
  }
  return undefined;
};

export const resolveUpdatedTo = (
  time: TimeFilter | undefined,
): string | undefined => (time?.mode === "custom" ? time.updatedTo : undefined);

export const clearTime = (filters: SearchFilters): SearchFilters => {
  const { time: _, ...rest } = filters;
  return rest;
};

export const setPresetTime = (
  filters: SearchFilters,
  preset: TimePreset | undefined,
): SearchFilters => {
  const rest = clearTime(filters);
  if (!preset) {
    return rest;
  }
  return { ...rest, time: { mode: "preset", preset } };
};

type CustomTimeRange = { updatedFrom?: string; updatedTo?: string };

export const setCustomTime = (
  filters: SearchFilters,
  range: CustomTimeRange,
): SearchFilters => {
  const rest = clearTime(filters);
  return {
    ...rest,
    time: {
      mode: "custom",
      ...(range.updatedFrom !== undefined && {
        updatedFrom: range.updatedFrom,
      }),
      ...(range.updatedTo !== undefined && { updatedTo: range.updatedTo }),
    },
  };
};

export const toggleArrayMember = <T>(items: readonly T[], value: T): T[] =>
  items.includes(value)
    ? items.filter((item) => item !== value)
    : [...items, value];
