/**
 * Arabic orthographic fold tables for SEARCH match-key normalization.
 *
 * Vendored from Lucene's ArabicNormalizer (Apache-2.0) and cross-checked
 * against CAMeL Tools (MIT), then extended for the classes Lucene omits:
 * alef-wasla, waw/yeh/standalone hamza, superscript alef, and Arabic-Indic
 * digits. Fold directions (alef variants to bare alef, teh-marbuta to heh,
 * alef-maksura to yeh) are the settled Lucene/CAMeL consensus.
 *
 * These folds are lossy match-key transforms: never apply them to stored
 * or displayed text, only to search keys.
 */

// One-to-one letter folds (source codepoint to target codepoint).
export const ARABIC_LETTER_FOLDS: Readonly<Record<string, string>> = {
  آ: "ا", // آ alef madda       -> ا alef
  أ: "ا", // أ alef hamza above -> ا alef
  إ: "ا", // إ alef hamza below -> ا alef
  ٱ: "ا", // ٱ alef wasla       -> ا alef
  ؤ: "و", // ؤ waw hamza        -> و waw
  ئ: "ي", // ئ yeh hamza        -> ي yeh
  ة: "ه", // ة teh marbuta      -> ه heh
  ى: "ي", // ى alef maksura     -> ي yeh
};

// Codepoints folded to nothing (removed). Tatweel, the eight harakat
// (U+064B–U+0652), decomposed hamza/madda marks, superscript alef, and
// standalone hamza.
export const ARABIC_REMOVED: readonly string[] = [
  "ء", // ء standalone hamza
  "ـ", // ـ tatweel / kashida
  "ً", // fathatan
  "ٌ", // dammatan
  "ٍ", // kasratan
  "َ", // fatha
  "ُ", // damma
  "ِ", // kasra
  "ّ", // shadda
  "ْ", // sukun
  "ٓ", // madda above
  "ٔ", // hamza above
  "ٕ", // hamza below
  "ٰ", // superscript alef
];

// Arabic-Indic (U+0660–0669) and Extended Arabic-Indic (U+06F0–06F9)
// digits to ASCII. Same mapping as @stll/stdnum's internal digit table;
// inlined here to avoid depending on another package's private util.
export const ARABIC_DIGIT_FOLDS: Readonly<Record<string, string>> = {
  "٠": "0",
  "١": "1",
  "٢": "2",
  "٣": "3",
  "٤": "4",
  "٥": "5",
  "٦": "6",
  "٧": "7",
  "٨": "8",
  "٩": "9",
  "۰": "0",
  "۱": "1",
  "۲": "2",
  "۳": "3",
  "۴": "4",
  "۵": "5",
  "۶": "6",
  "۷": "7",
  "۸": "8",
  "۹": "9",
};

const FOLD_MAP: ReadonlyMap<string, string> = new Map<string, string>([
  ...Object.entries(ARABIC_LETTER_FOLDS),
  ...Object.entries(ARABIC_DIGIT_FOLDS),
  ...ARABIC_REMOVED.map((char): readonly [string, string] => [char, ""]),
]);

/**
 * Apply the Arabic letter, digit, and removal folds codepoint by
 * codepoint. Non-Arabic characters pass through unchanged.
 *
 * Deliberately does not normalize. Unicode normalization is whole-string
 * work — NFKC composes across codepoint boundaries — so it belongs to
 * the caller, before the fold: `arabicNormalize` applies NFKC to the
 * whole string and then calls this. Folding is a per-codepoint table
 * lookup and stays that way.
 */
export const applyArabicFolds = (text: string): string => {
  // Fast path for the single-code-unit calls made character-by-character
  // when building offset maps; avoids an array allocation per character.
  if (text.length === 1) {
    return FOLD_MAP.get(text) ?? text;
  }
  const out: string[] = [];
  for (const char of text) {
    out.push(FOLD_MAP.get(char) ?? char);
  }
  return out.join("");
};

export type FoldedText = {
  // For each UTF-16 code-unit index `i` in `text`, the code-unit index in
  // the original input immediately after that unit's source character.
  sourceEndIndex: number[];
  text: string;
  // True when normalization stopped before consuming the full input because
  // the folded text reached the caller's scan budget.
  truncated: boolean;
  // For each UTF-16 code-unit index `i` in `text`, the code-unit index in
  // the original input where that unit's source character began.
  // `sourceIndex[text.length]` is the end of the consumed source prefix (the
  // full original length when `truncated` is false), so a match's [start, end)
  // in folded space maps back to original offsets.
  sourceIndex: number[];
};

type ApplyArabicFoldsWithOffsetsOptions = {
  maxFoldedUnits?: number;
};

/**
 * Fold Arabic variants and return an offset map, so a caller matching
 * against the folded text (find-in-page, search previews) can slice the
 * original at the right positions.
 *
 * Not simply `applyArabicFolds` plus offsets. This variant additionally
 * normalizes NFKC one character at a time, because it is meant for raw
 * document text: Arabic PDFs carry presentation forms (`ﺍﺣﻤﺪ`) and
 * ligatures (`ﷲ`, `ﷺ`) that must expand to canonical letters to be
 * searchable at all. Per character, not whole string, is what keeps
 * every unit of an expansion pointing back at the one source character
 * it came from — whole-string NFKC composes across boundaries and would
 * describe positions the map no longer has. The `maxFoldedUnits` budget
 * exists for the same reason: one ligature can expand to eighteen
 * characters.
 *
 * The consequence is a deliberate asymmetry with `applyArabicFolds`,
 * which never normalizes. On a compatibility character the two disagree:
 *
 *     applyArabicFolds("ﬁ")            === "ﬁ"
 *     applyArabicFoldsWithOffsets("ﬁ") === "fi"
 *
 * They agree on NFKC-normalized input, and that is the state both sides
 * of a comparison are in wherever the two are used together: the API's
 * search highlighter folds its source through `normalizeSourceWithMappings`
 * and each candidate through `arabicNormalize`, and both apply
 * whole-string NFKC before either fold runs. Feeding raw text to one side
 * and normalized text to the other is what would misplace a highlight, so
 * normalize both or neither.
 */
export const applyArabicFoldsWithOffsets = (
  input: string,
  options: ApplyArabicFoldsWithOffsetsOptions = {},
): FoldedText => {
  const parts: string[] = [];
  const sourceEndIndex: number[] = [];
  const sourceIndex: number[] = [];
  const maxFoldedUnits = options.maxFoldedUnits ?? Number.POSITIVE_INFINITY;
  let foldedUnits = 0;
  let originalUnit = 0;
  let truncated = false;
  for (const char of input) {
    const replacement = applyArabicFolds(char.normalize("NFKC"));
    if (foldedUnits + replacement.length > maxFoldedUnits) {
      truncated = true;
      break;
    }

    const originalEnd = originalUnit + char.length;
    parts.push(replacement);
    // One offset entry per UTF-16 code unit of the replacement; folds are
    // BMP, but an unfolded astral passthrough spans two code units.
    let unit = 0;
    while (unit < replacement.length) {
      sourceIndex.push(originalUnit);
      sourceEndIndex.push(originalEnd);
      unit += 1;
    }
    foldedUnits += replacement.length;
    originalUnit = originalEnd;
  }
  sourceIndex.push(originalUnit);
  sourceEndIndex.push(originalUnit);
  return { sourceEndIndex, text: parts.join(""), truncated, sourceIndex };
};
