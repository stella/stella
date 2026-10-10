import * as v from "valibot";

import {
  PROVISION_CITING_DECISION_SORTS,
  PROVISION_CITING_FILTER_LIMITS,
} from "@stll/api-contract/provision-citing-decisions";
import { normalizeStatuteVersionSegment } from "@stll/api-contract/statute-route";
import { parsePlainDate } from "@stll/time";

import { isStatuteCompareShow } from "@/features/statutes/statute-compare-search";

/**
 * A calendar day, not merely a date-shaped string: `2026-02-30` matches the
 * pattern and is not a day, and the reader must not ask the corpus for it.
 */
const isCalendarDate = (value: string): boolean =>
  parsePlainDate(value) !== null;

const MAX_JUMP_LENGTH = 32;
/** The API's own bound on a provision anchor. */
const MAX_PROVISION_ANCHOR_LENGTH = 256;

/**
 * The search a statute page's URL carries, read the same way by the page's
 * routes and by every link that opens the act elsewhere.
 *
 * `asOf` names the day whose law the reader wants. It is a lookup, not an
 * address: the loader resolves it to the consolidation that applied and sends
 * the reader to that consolidation's own URL, so one text has one indexable
 * address. Anything unparseable is dropped rather than rejected — a mistyped
 * link should still open the act.
 */
const provisionCitingSearchSchema = v.object({
  citingCourt: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.maxLength(PROVISION_CITING_FILTER_LIMITS.courtChars),
    ),
  ),
  citingYear: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(PROVISION_CITING_FILTER_LIMITS.yearMin),
      v.maxValue(PROVISION_CITING_FILTER_LIMITS.yearMax),
    ),
  ),
  citingSort: v.optional(v.picklist(PROVISION_CITING_DECISION_SORTS), "newest"),
});

export const readProvisionCitingSearch = (search: unknown) => {
  const result = v.safeParse(provisionCitingSearchSchema, search);
  return result.success
    ? result.output
    : v.parse(provisionCitingSearchSchema, {});
};

export type ProvisionCitingSearch = v.InferOutput<
  typeof provisionCitingSearchSchema
>;

export const updateProvisionCitingSearch = <T extends Record<string, unknown>>(
  previous: T,
  filters: ProvisionCitingSearch,
) => {
  const {
    citingCourt: _court,
    citingYear: _year,
    citingSort: _sort,
    ...rest
  } = previous;
  return {
    ...rest,
    citingSort: filters.citingSort,
    ...(filters.citingCourt ? { citingCourt: filters.citingCourt } : {}),
    ...(filters.citingYear === undefined
      ? {}
      : { citingYear: filters.citingYear }),
  };
};

export const publicStatuteSearchSchema = v.object({
  ...provisionCitingSearchSchema.entries,
  citingSort: v.optional(v.picklist(PROVISION_CITING_DECISION_SORTS)),
  q: v.optional(v.pipe(v.string(), v.trim())),
  asOf: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.transform((value) => (isCalendarDate(value) ? value : undefined)),
    ),
  ),
  /**
   * A provision designation to open at (`§ 2079`), as the statutes box sends
   * it. Read by the outline's jump field; anything it cannot parse just
   * narrows nothing.
   */
  jump: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.transform((value) =>
        value.length > 0 && value.length <= MAX_JUMP_LENGTH ? value : undefined,
      ),
    ),
  ),
  /**
   * Another consolidation to set beside the one on screen, named by the day
   * its validity window opened. The reader then shows the two wordings side
   * by side instead of the text.
   */
  compare: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.transform(
        (value) => normalizeStatuteVersionSegment(value) ?? undefined,
      ),
    ),
  ),
  /** The provision heading anchor a comparison is narrowed to. */
  provision: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.transform((value) =>
        value.length > 0 && value.length <= MAX_PROVISION_ANCHOR_LENGTH
          ? value
          : undefined,
      ),
    ),
  ),
  /** Which provisions a whole-act comparison lists; changed ones by default. */
  show: v.optional(
    v.pipe(
      v.string(),
      v.transform((value) => (isStatuteCompareShow(value) ? value : undefined)),
    ),
  ),
});

export type PublicStatuteSearch = v.InferOutput<
  typeof publicStatuteSearchSchema
>;
