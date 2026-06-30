import { applyArabicFolds } from "./arabic.js";

const ASCII_UPPERCASE_RE = /[A-Zİ]/gu;
const SEARCH_WHITESPACE_RE =
  /[ \t\n\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/gu;

const foldSearchCase = (text: string): string =>
  text.replace(ASCII_UPPERCASE_RE, (char) => {
    if (char === "İ") {
      return "i";
    }
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      return char;
    }
    return String.fromCodePoint(codePoint + 32);
  });

/**
 * Canonical search match-key normalizer. Folds Arabic orthographic
 * variants so a query matches regardless of how the text was typed
 * (alef/hamza/teh-marbuta/yeh variants, tashkeel, tatweel, Arabic-Indic
 * digits), then applies locale-stable ASCII case folding for mixed-script
 * names.
 *
 * NFKC runs first so presentation forms (U+FB50–FDFF, U+FE70–FEFF) fold
 * to their canonical letters before the explicit folds apply.
 *
 * This MUST stay consistent with the SQL `arabic_normalize()` function;
 * the golden vectors in normalize.test.ts pin the contract for both.
 */
export const normalizeSearchText = (text: string): string =>
  foldSearchCase(applyArabicFolds(text.normalize("NFKC")))
    .replace(SEARCH_WHITESPACE_RE, " ")
    .trim();
