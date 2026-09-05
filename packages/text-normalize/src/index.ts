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
