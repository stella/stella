// parser-output-unchanged: [at-asylgh] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-bks] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-bvwg] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-courts] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-findok] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-lvwg] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-ubas] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-umse] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-uvs] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-verg] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-vfgh] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [at-vwgh] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [cz-ns] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [cz-nss] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [cz-regional] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [cz-us] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [hu-bhgy] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [pl-kis] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [pl-nsa] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [pl-uokik] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [sk-courts] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [sk-us] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [uk-fcl] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: [us-courtlistener] registered replay fixture fields are unchanged by numeric index normalization.
// parser-output-unchanged: Unicode owner migration retains native normalization forms, mark classes and operation order; no folding is added.
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
} from "./search-match.js";
export type { FoldedSearchText, SearchMatchRange } from "./search-match.js";
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

export { normalizeNumericIndices } from "./numeric-indices.js";
