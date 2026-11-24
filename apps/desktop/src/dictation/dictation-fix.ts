/** What the fix panel shows, as `dictation_fix_get_state` answers. */
export type FixRequest = {
  /** The words selected in the app the speaker works in. */
  selection: string | null;
  /** Without a selection: the last dictation's words to pick from. */
  lastWords: string[];
};

/** Why words cannot be a fix; mirrors `Refusal` in `dictation_learned.rs`. */
const FIX_REFUSALS = [
  "empty",
  "lineBreak",
  "tooLong",
  "tooManyWords",
  "same",
  "punctuation",
] as const;

export type FixRefusal = (typeof FIX_REFUSALS)[number];

/** What `dictation_fix_save` answers; mirrors `FixSaved`. */
type FixSaved =
  | { status: "saved" }
  | { reason: FixRefusal; status: "refused" }
  | { status: "notSaved" };

/** The most words one fix takes; the contract's `maxWords`. */
const MAX_FIX_WORDS = 3;

/** Picked words of the last dictation, both ends included. */
export type WordRange = { end: number; start: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isFixRequest = (value: unknown): value is FixRequest =>
  isRecord(value) &&
  (value["selection"] === null || typeof value["selection"] === "string") &&
  Array.isArray(value["lastWords"]) &&
  value["lastWords"].every((word: unknown) => typeof word === "string");

const isFixRefusal = (value: unknown): value is FixRefusal =>
  FIX_REFUSALS.some((refusal) => refusal === value);

export const isFixSaved = (value: unknown): value is FixSaved => {
  if (!isRecord(value)) {
    return false;
  }
  switch (value["status"]) {
    case "saved":
    case "notSaved":
      return true;
    case "refused":
      return isFixRefusal(value["reason"]);
    default:
      return false;
  }
};

/**
 * The words picked once `index` is picked: a word next to the picked ones
 * joins them while the phrase stays within a fix's length; any other word
 * starts over.
 */
export const wordRange = (
  picked: WordRange | null,
  index: number,
): WordRange => {
  if (picked === null) {
    return { end: index, start: index };
  }
  const length = picked.end - picked.start + 1;
  if (length < MAX_FIX_WORDS && index === picked.end + 1) {
    return { end: index, start: picked.start };
  }
  if (length < MAX_FIX_WORDS && index === picked.start - 1) {
    return { end: picked.end, start: index };
  }
  return { end: index, start: index };
};

/** The picked words, joined by single spaces. */
export const pickWords = (words: readonly string[], range: WordRange) =>
  words.slice(range.start, range.end + 1).join(" ");

/** Each word with its place, which tells repeated words apart. */
export const placed = (words: readonly string[]) =>
  words.map((word, place) => ({ place, word }));
