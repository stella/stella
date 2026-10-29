// parser-output-unchanged: numeric index normalization is called only by corpus query tokenization, never ingestion.
import { normalizeUnicode } from "./unicode.js";

const NUMERIC_SUPERSCRIPT_INDEX = /(?<=\d)[⁰¹²³⁴⁵⁶⁷⁸⁹]+/gu;

/**
 * Keep a numeric superscript attached to a number distinct from its digits.
 * Run before compatibility folding: NFKC alone turns `505⁹` into `5059`.
 * Caret and parenthesized indices already have an ordinary token boundary.
 */
export const normalizeNumericIndices = (text: string): string =>
  text.replace(
    NUMERIC_SUPERSCRIPT_INDEX,
    (index) => `^${normalizeUnicode(index, "NFKC")}`,
  );
