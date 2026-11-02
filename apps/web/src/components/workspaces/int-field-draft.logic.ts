/**
 * What committing an int cell's draft does. The comparison is against the
 * stored value, so an empty cell (`null`) and a stored 0 are different states.
 */
export type IntFieldDraftCommit =
  | { kind: "unchanged" }
  | { kind: "save"; value: number | null }
  | { kind: "invalid" };

// Spaces (including the no-break and narrow no-break spaces locales use as
// thousands separators) are grouping, never part of the number.
const GROUPING_SPACES = /[\s  ]/gu;
const WHOLE_NUMBER = /^[+-]?\d+$/u;

/**
 * Parses an int cell's draft. An empty draft clears the cell; anything that is
 * not a whole number is refused rather than rounded, because a silently
 * changed value is worse than asking again.
 */
export const commitIntFieldDraft = (
  draft: string,
  stored: number | null,
): IntFieldDraftCommit => {
  const compact = draft.replaceAll(GROUPING_SPACES, "");
  if (compact === "") {
    return stored === null
      ? { kind: "unchanged" }
      : { kind: "save", value: null };
  }
  if (!WHOLE_NUMBER.test(compact)) {
    return { kind: "invalid" };
  }
  const value = Number(compact);
  if (!Number.isSafeInteger(value)) {
    return { kind: "invalid" };
  }
  // -0 and 0 are the same stored number.
  const normalized = value === 0 ? 0 : value;
  return normalized === stored
    ? { kind: "unchanged" }
    : { kind: "save", value: normalized };
};
