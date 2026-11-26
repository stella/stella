// Designators as contracts print them: the `XI` of `Článek XI.`, the `5.1` of
// `5.1.`, the `d` of `d)`. One reader serves automatic list labels, labels
// typed at the start of a paragraph, and the numbering formats a template
// level renders with.

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import {
  parseRomanNumeral,
  romanNumeral,
} from "@stll/api-contract/magyar-kozlony-designation";

/** `lowerAmbiguous` and `upperAmbiguous` are single characters that are both
 *  a letter and a roman numeral (`i`, `v`, `x`); the list they stand in
 *  decides. */
export type DesignatorNumeral =
  | "decimal"
  | "upperRoman"
  | "lowerRoman"
  | "upperLetter"
  | "lowerLetter"
  | "upperAmbiguous"
  | "lowerAmbiguous";

type LabelKeyword = "article" | "sectionSign" | "annex";

export type LabelShape = {
  keyword: LabelKeyword | null;
  /** `(` when the designator opens with one. */
  open: string;
  /** The designator as written, without brackets or a closing period. */
  core: string;
  /** `)` when the designator closes with one. */
  close: string;
  /** Whether a period follows the designator. */
  period: boolean;
  numeral: DesignatorNumeral;
  /** Components of a decimal designator: `5.1.2` is `[5, 1, 2]`, and
   *  `II.18.1`, whose part is counted in roman numerals, is `[2, 18, 1]`. */
  path: number[] | null;
  /** Characters of the input the label takes, from its start. */
  length: number;
};

const ARTICLE_KEYWORD =
  /^(?:článek|čl\.|artikel|article|art\.|section|clause|ziffer|ziff\.)[ \u00A0]*(?:(?:č\.|no\.|nr\.)[ \u00A0]*)?/iu;
const SECTION_SIGN_KEYWORD = /^§[ \u00A0]*/u;
const ANNEX_KEYWORD =
  /^(?:příloha|annexure|annex|schedule|appendix|exhibit|anlage|anhang)[ \u00A0]*(?:(?:č\.|no\.|nr\.)[ \u00A0]*)?/iu;

const KEYWORDS = [
  ["article", ARTICLE_KEYWORD],
  ["sectionSign", SECTION_SIGN_KEYWORD],
  ["annex", ANNEX_KEYWORD],
] as const satisfies readonly (readonly [LabelKeyword, RegExp])[];

const DESIGNATOR =
  /^(\(?)((?:\d{1,3}|[IVXLCDM]{1,7}(?=\.\d))(?:\.\d{1,3}){0,4}|[IVXLCDM]{1,7}|[a-z]{1,5}|[A-Z]{1,3})(\)?)(\.?)(?![\p{L}\p{N}]|\.\d)/u;

const AMBIGUOUS_LOWER = new Set(["i", "v", "x", "l", "c", "d", "m"]);

const LETTERS_IN_ALPHABET = 26;
/** `aaa` is item 53; no list of letters runs longer. */
const REPEATED_LETTER_MAX = 3;
const LOWER_A = 97;

/** A letter designator's ordinal the way Word counts: `a` is 1, `z` is 26,
 *  then the letter doubles (`aa` is 27). Null for anything else. */
export const letterOrdinal = (token: string): number | null => {
  const lower = token.toLowerCase();
  const first = lower.codePointAt(0);
  const letter = lower.charAt(0);
  // One letter, repeated: `a`, `bb`, never `ab`.
  if (
    first === undefined ||
    !/^[a-z]$/u.test(letter) ||
    lower !== letter.repeat(lower.length)
  ) {
    return null;
  }
  return (lower.length - 1) * LETTERS_IN_ALPHABET + (first - LOWER_A) + 1;
};

const formatLetter = (value: number): string | null => {
  if (!Number.isSafeInteger(value) || value < 1) {
    return null;
  }
  const letter = String.fromCodePoint(
    LOWER_A + ((value - 1) % LETTERS_IN_ALPHABET),
  );
  return letter.repeat(Math.ceil(value / LETTERS_IN_ALPHABET));
};

/** Renders a counter in a WordprocessingML number format; null for a format
 *  with no designator (`bullet`, `none`) or one this reader does not know. */
export const formatNumeral = (value: number, numFmt: string): string | null => {
  switch (numFmt) {
    case "decimal":
      return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
    case "upperRoman":
      return romanNumeral(value);
    case "lowerRoman":
      return romanNumeral(value)?.toLowerCase() ?? null;
    case "lowerLetter":
      return formatLetter(value);
    case "upperLetter":
      return formatLetter(value)?.toUpperCase() ?? null;
    default:
      return null;
  }
};

/** A run of decimal digits as a number; null for anything else. */
export const digitsValue = (digits: string): number | null => {
  const parsed = parseIntegerToken(digits, { sign: "unsigned" });
  return parsed.isOk() ? parsed.value : null;
};

/** The components of a dotted number: `5.1.2` is `[5, 1, 2]`. Contracts in
 *  parts count the part in roman numerals, so `II.18.1` is `[2, 18, 1]`.
 *  Null when a component is not a plain number (`5a`). */
export const decimalPath = (core: string): number[] | null => {
  const [first = "", ...rest] = core.split(".");
  const head =
    digitsValue(first) ??
    (rest.length > 0 && first === first.toUpperCase()
      ? parseRomanNumeral(first)
      : null);
  if (head === null) {
    return null;
  }
  const path = [head];
  for (const part of rest) {
    const value = digitsValue(part);
    if (value === null) {
      return null;
    }
    path.push(value);
  }
  return path;
};

const classifyNumeral = (
  core: string,
  keyword: LabelKeyword | null,
): DesignatorNumeral | null => {
  if (/^\d/u.test(core) || (core.includes(".") && decimalPath(core) !== null)) {
    return "decimal";
  }
  const isUpper = core === core.toUpperCase();
  const roman = parseRomanNumeral(core);
  if (core.length === 1) {
    if (!AMBIGUOUS_LOWER.has(core.toLowerCase())) {
      return isUpper ? "upperLetter" : "lowerLetter";
    }
    // An article or a section is counted, never lettered.
    if (keyword === "article" || keyword === "sectionSign") {
      return isUpper ? "upperRoman" : "lowerRoman";
    }
    return isUpper ? "upperAmbiguous" : "lowerAmbiguous";
  }
  if (roman !== null) {
    return isUpper ? "upperRoman" : "lowerRoman";
  }
  // Past `z` the letter repeats: `aa`, `BB`.
  if (core.length <= REPEATED_LETTER_MAX && letterOrdinal(core) !== null) {
    return isUpper ? "upperLetter" : "lowerLetter";
  }
  return null;
};

/** Reads a label at the start of `text`: an optional keyword (`Článek`,
 *  `§`, `Příloha č.`), then one designator. Null when the text does not open
 *  with one. Leading blanks are not skipped; the caller owns them. */
export const parseLabelShape = (text: string): LabelShape | null => {
  let keyword: LabelKeyword | null = null;
  let offset = 0;
  for (const [candidate, pattern] of KEYWORDS) {
    const match = pattern.exec(text);
    if (match) {
      keyword = candidate;
      offset = match[0].length;
      break;
    }
  }
  const match = DESIGNATOR.exec(text.slice(offset));
  if (!match) {
    return null;
  }
  const [whole, open = "", core = "", close = "", period = ""] = match;
  if (open !== "" && close === "") {
    return null;
  }
  const numeral = classifyNumeral(core, keyword);
  if (numeral === null) {
    return null;
  }
  return {
    keyword,
    open,
    core,
    close,
    period: period !== "",
    numeral,
    path: numeral === "decimal" ? decimalPath(core) : null,
    length: offset + whole.length,
  };
};

/** A roman or decimal designator's ordinal: `XI` and `11` are both 11. */
export const countedOrdinal = (core: string): number | null =>
  digitsValue(core) ?? parseRomanNumeral(core);

/** What a numbered cross-reference field shows for a label: the designator
 *  with its brackets, without keyword and without the closing period. */
export const labelFieldText = ({ open, core, close }: LabelShape): string =>
  `${open}${core}${close}`;
