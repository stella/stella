import { panic } from "better-result";
import * as v from "valibot";

import { lawYearSearchSchema } from "@stll/api-contract/law-year";
import { LEGISLATION_LIST_VALIDITIES } from "@stll/api-contract/legislation-status";

import type { StatutesIndexSearch } from "./statute-index-search.logic";

/**
 * What the statute list may be narrowed by, as the URL names it. Kept apart
 * from the popover that draws the filters: the route's loader reads the keys,
 * and importing them from a component module would pull the popover into the
 * eagerly loaded route chunk.
 */
export type StatuteFilterKey = "type" | "validity" | "year";

/** Whether each filter is on, per key; total, so a new key must say. */
const statuteFiltersOn = (
  search: Pick<StatutesIndexSearch, StatuteFilterKey>,
): Record<StatuteFilterKey, boolean> => ({
  type: search.type !== undefined,
  validity: search.validity !== undefined,
  year: search.year !== undefined,
});

export const activeStatuteFilterCount = (
  search: Pick<StatutesIndexSearch, StatuteFilterKey>,
): number => Object.values(statuteFiltersOn(search)).filter(Boolean).length;

/**
 * The act year a year field committed, as the URL holds it, or undefined for
 * an empty field or a number no act year can be.
 */
export const statuteFilterYear = (value: number | null): string | undefined => {
  if (value === null) {
    return undefined;
  }
  const parsed = v.safeParse(lawYearSearchSchema, String(value));
  return parsed.success ? parsed.output : undefined;
};

/**
 * The URL with one filter set or unset. Written out per key rather than by a
 * computed property, so a filter key that is not in the search schema cannot
 * be navigated to. Callers pass the result through `changeStatutesIndexQuery`,
 * which drops the page and an order the new filters no longer bound.
 */
export const withStatuteFilter = (
  previous: StatutesIndexSearch,
  key: StatuteFilterKey,
  value: string | undefined,
): StatutesIndexSearch => {
  switch (key) {
    case "type":
      return { ...previous, type: value };
    case "validity":
      return {
        ...previous,
        validity: LEGISLATION_LIST_VALIDITIES.find(
          (validity) => validity === value,
        ),
      };
    case "year": {
      const parsed = v.safeParse(lawYearSearchSchema, value);
      return { ...previous, year: parsed.success ? parsed.output : undefined };
    }
    default:
      key satisfies never;
      return panic(`Unhandled statute filter: ${String(key)}`);
  }
};
