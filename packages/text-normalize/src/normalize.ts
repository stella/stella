import { applyArabicFolds } from "./arabic.js";

const WHITESPACE_RE = /\s+/gu;

/**
 * Canonical search match-key normalizer. Folds Arabic orthographic
 * variants so a query matches regardless of how the text was typed
 * (alef/hamza/teh-marbuta/yeh variants, tashkeel, tatweel, Arabic-Indic
 * digits), and is a harmless NFKC + lowercase pass on other scripts.
 *
 * NFKC runs first so presentation forms (U+FB50–FDFF, U+FE70–FEFF) fold
 * to their canonical letters before the explicit folds apply.
 *
 * This MUST stay consistent with the SQL `arabic_normalize()` function;
 * the golden vectors in normalize.test.ts pin the contract for both.
 */
export const normalizeSearchText = (text: string): string =>
  applyArabicFolds(text.normalize("NFKC"))
    .toLowerCase()
    .replace(WHITESPACE_RE, " ")
    .trim();
