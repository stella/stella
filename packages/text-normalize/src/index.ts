export {
  applyArabicFolds,
  applyArabicFoldsWithOffsets,
  ARABIC_DIGIT_FOLDS,
  ARABIC_LETTER_FOLDS,
  ARABIC_REMOVED,
} from "./arabic.js";
export type { FoldedText } from "./arabic.js";
export { stripDiacritics, stripDiacriticsForSlug } from "./diacritics.js";
export { normalizeSearchText } from "./normalize.js";
export {
  collapseSpacedLetters,
  spacedLetterRunRegex,
} from "./spaced-letters.js";
