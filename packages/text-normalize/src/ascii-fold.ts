/**
 * Latin-ASCII folding for search keys whose counterpart is a PostgreSQL
 * `unaccent()` index or a Tantivy `ascii_folding` index.
 *
 * `stripDiacritics` decomposes with NFD and drops combining marks, which can
 * only fold letters that have a canonical decomposition. Polish `ł` has none,
 * so it survives a mark strip while `unaccent('łaska')` yields `laska`: a query
 * containing `ł` then under-matches the very lexemes the index stored for it.
 * `foldToAscii` keeps NFD plus mark removal as the base and adds the rules
 * `unaccent` applies that decomposition cannot express.
 */

import { ASCII_FOLD_TABLE } from "./ascii-fold-table.js";

// The table is matched before `\p{Diacritic}` so modifier letters that Unicode
// classifies as diacritics (`ʰ`, `ᴬ`) fold to their base letter the way
// `unaccent` folds them, instead of being deleted by the mark strip. Every key
// is a single code point outside the character-class metacharacter set, so the
// class needs no escaping.
const ASCII_FOLD_RE = new RegExp(
  `[${Object.keys(ASCII_FOLD_TABLE).join("")}]|\\p{Diacritic}`,
  "gu",
);

/**
 * The replace step of `foldToAscii`, for callers that decompose themselves
 * (`foldSearchMatchText` decomposes with NFKD and per character). The input
 * must already be decomposed or table-only characters would hide inside
 * precomposed letters.
 */
export const applyAsciiFolds = (decomposed: string): string =>
  decomposed.replace(ASCII_FOLD_RE, (char) => ASCII_FOLD_TABLE[char] ?? "");

/**
 * Fold text to its ASCII search key.
 *
 * The contract is parity with `unaccent()` for Latin-script characters: for
 * every rule the extension declares over `\p{Script=Latin}`, this produces the
 * same output. Other scripts are out of contract and keep whatever NFD plus
 * mark removal leaves, so Greek, Cyrillic, and Arabic text passes through with
 * its own diacritics stripped and its letters intact. Output is ASCII wherever
 * the input was Latin, and folding is idempotent.
 */
export const foldToAscii = (text: string): string =>
  applyAsciiFolds(text.normalize("NFD"));
