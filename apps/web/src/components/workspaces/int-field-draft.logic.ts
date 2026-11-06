import { parseIntegerToken } from "@stll/agent-input/numeric-token";

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
// A leading plus is the same number; the token grammar takes only a minus.
const EXPLICIT_PLUS = /^\+(?=[0-9])/u;

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
  const parsed = parseIntegerToken(compact.replace(EXPLICIT_PLUS, ""));
  if (parsed.isErr()) {
    return { kind: "invalid" };
  }
  // -0 and 0 are the same stored number.
  const value = parsed.value === 0 ? 0 : parsed.value;
  return value === stored ? { kind: "unchanged" } : { kind: "save", value };
};
