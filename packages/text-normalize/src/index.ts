// parser-output-unchanged: Unicode owner migration retains native normalization forms, mark classes and operation order; no folding is added.
// parser-output-unchanged: exports the opt-in search match options; default folds are unchanged.
export {
  applyArabicFolds,
  applyArabicFoldsWithOffsets,
  ARABIC_DIGIT_FOLDS,
  ARABIC_LETTER_FOLDS,
  ARABIC_REMOVED,
} from "./arabic.js";
export type { FoldedText } from "./arabic.js";
export { foldToAscii } from "./ascii-fold.js";
export { ASCII_FOLD_TABLE } from "./ascii-fold-table.js";
export { stripDiacritics, stripDiacriticsForSlug } from "./diacritics.js";
export { escapeRegExp } from "./escape-regexp.js";
export { arabicNormalize } from "./normalize.js";
export {
  findSearchMatchRanges,
  foldSearchMatchText,
  foldSearchMatchTextWithOffsets,
  hasFoldedSearchMatch,
} from "./search-match.js";
export type {
  FoldedSearchText,
  SearchFoldOptions,
  SearchMatchOptions,
  SearchMatchRange,
} from "./search-match.js";
export {
  collapseSpacedLetters,
  spacedLetterRunRegex,
} from "./spaced-letters.js";
export { slugify } from "./slug.js";
export type { SlugCharset, SlugifyOptions, SlugSeparator } from "./slug.js";
export {
  normalizeUnicode,
  stripUnicodeMarks,
  UNICODE_NORMALIZATION_FORMS,
} from "./unicode.js";
export type { UnicodeMarkClass, UnicodeNormalizationForm } from "./unicode.js";
