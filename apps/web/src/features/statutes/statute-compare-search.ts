/**
 * The comparison's address, kept apart from the comparison itself so the
 * reader route can parse it without loading the diff engine.
 */

/** Which provisions a whole-act comparison lists. */
export const STATUTE_COMPARE_SHOW = {
  changed: "changed",
  all: "all",
} as const;

export type StatuteCompareShow =
  (typeof STATUTE_COMPARE_SHOW)[keyof typeof STATUTE_COMPARE_SHOW];

export const isStatuteCompareShow = (
  value: string,
): value is StatuteCompareShow =>
  Object.values<string>(STATUTE_COMPARE_SHOW).includes(value);

/**
 * What the reader's comparison search params say, `compare` naming the other
 * consolidation by the day its validity window opened (the same spelling as
 * the `/v/` segment). Every field absent is the plain reader.
 */
export type StatuteCompareSearch = {
  compare: string | undefined;
  provision: string | undefined;
  show: StatuteCompareShow | undefined;
};

export const NO_STATUTE_COMPARE: StatuteCompareSearch = {
  compare: undefined,
  provision: undefined,
  show: undefined,
};
