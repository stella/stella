/**
 * Numbers on the agent wire.
 *
 * A model writing a rent, a deposit, or a headcount copies the notation of the
 * document it is drafting: `4 000`, `4,000.50`, `1 234,50`, `1.234,50`,
 * `EUR 100`, `100 EUR`, `100.-`, `1e3`. Group separators, currency, and the
 * accounting dash carry no numeric meaning and are read away.
 *
 * `1,234` is the one form that carries two meanings — 1234 under English
 * grouping, 1.234 under continental decimals — and no amount of context inside
 * the string decides it. A caller that knows the field's locale passes it and
 * the locale decides; otherwise the value is asked for again, naming both
 * readings. Guessing here is a silent factor-of-1000 error on a monetary term.
 */

import { Result } from "better-result";

import type { Normalized } from "./normalized";
import { askForFix, readValue, readValueAs } from "./normalized";

const NUMBER_EXPECTED = "a number";
const NUMBER_HINT =
  'Send the number as a JSON number (1234.5). Digit grouping ("4 000"), a ' +
  'currency ("EUR 100"), and scientific notation ("1e3") are read as well.';

/** The separators a model uses to group thousands. `\s` covers the narrow and
 *  non-breaking spaces `Intl` itself emits. */
const GROUPING_SPACE_RE = /[\s']/gu;
/** Currency notation is accepted only as one affix, never as prose interleaved
 * with digits. ISO codes cover the portable spelling; this small set covers
 * alphabetic symbols emitted by the locales exercised by Stella today. */
const ISO_CURRENCY_CODES = new Set(Intl.supportedValuesOf("currency"));
const ALPHABETIC_CURRENCY_SYMBOLS = new Set(["Kč", "zł", "kr", "lei", "Ft"]);
const CURRENCY_TOKEN_RE = /[\p{L}\p{Sc}]+/gu;
const CURRENCY_SYMBOL_RE = /^(?:[A-Z]{1,2})?\p{Sc}$/u;
const ISO_CURRENCY_CODE_RE = /^[A-Za-z]{3}$/u;
/** The accounting "and no cents" dash: `100.-`, `100,-`. */
const ACCOUNTING_DASH_RE = /[.,]\s*-$/u;
const SCIENTIFIC_RE = /^[+-]?\d+(?:\.\d+)?[eE][+-]?\d+$/u;
/** Digits and separators only, at least one digit. The head before the first
 *  digit is separators alone, so no two quantifiers compete for the same
 *  character and the match is linear in the input. */
const DIGITS_AND_SEPARATORS_RE = /^[+-]?[.,]*\d[\d.,]*$/u;
/** A single separator with exactly three digits behind it: a thousands group
 *  and a three-decimal fraction are spelled identically. */
const THREE_DIGIT_TAIL_RE = /^\d{1,3}[.,]\d{3}$/u;

export type NumberOptions = {
  /** The field's locale, when one is configured. It decides `1,234`. */
  locale?: string | undefined;
};

/** The decimal mark the locale uses, or null when `Intl` refuses the tag. */
const localeDecimalMark = (locale: string): string | null => {
  const parts = Result.try({
    try: () => new Intl.NumberFormat(locale).formatToParts(1.5),
    catch: (cause) => cause,
  });
  if (parts.isErr()) {
    return null;
  }
  return parts.value.find((part) => part.type === "decimal")?.value ?? null;
};

/** Which of `,` and `.` marks the fraction, given both appear: whichever comes
 *  last, because the other one has to be grouping. */
const lastSeparator = (body: string): string => {
  const comma = body.lastIndexOf(",");
  const dot = body.lastIndexOf(".");
  return comma > dot ? "," : ".";
};

const toNumber = (body: string, decimalMark: string | null): number =>
  Number(
    decimalMark === null
      ? body.replaceAll(",", "").replaceAll(".", "")
      : body
          .replaceAll(decimalMark === "," ? "." : ",", "")
          .replace(decimalMark, "."),
  );

/** The separator carries both readings and no locale decides it. A symbol,
 *  not a string, so the decision cannot be confused with a decimal mark. */
const AMBIGUOUS = Symbol("ambiguous decimal mark");

const ambiguousAsk = (input: unknown, body: string, separator: string) => {
  const grouped = toNumber(body, null);
  const fractional = toNumber(body, separator);
  return askForFix({
    input,
    expected: NUMBER_EXPECTED,
    hint:
      `"${body}" reads as ${grouped} with "${separator}" grouping the ` +
      `thousands, or as ${fractional} with "${separator}" as the decimal ` +
      `mark. Send ${grouped} or ${fractional} as a JSON number.`,
  });
};

const isCurrencyToken = (token: string): boolean =>
  CURRENCY_SYMBOL_RE.test(token) ||
  ALPHABETIC_CURRENCY_SYMBOLS.has(token) ||
  (ISO_CURRENCY_CODE_RE.test(token) &&
    ISO_CURRENCY_CODES.has(token.toUpperCase()));

const withoutCurrencyAffix = (input: string): string | null => {
  const tokens = [...input.matchAll(CURRENCY_TOKEN_RE)];
  if (tokens.length === 0) {
    return input;
  }
  if (tokens.length !== 1) {
    return null;
  }
  const token = tokens.at(0);
  if (token === undefined || !isCurrencyToken(token[0])) {
    return null;
  }
  const index = token.index;
  const before = input.slice(0, index);
  const after = input.slice(index + token[0].length);
  if (/\d/u.test(before) && /\d/u.test(after)) {
    return null;
  }
  return `${before}${after}`;
};

/** Read a number an agent spelled its own way. */
export const normalizeNumber = (
  input: unknown,
  options?: NumberOptions,
): Normalized<number> => {
  if (typeof input === "number") {
    return Number.isFinite(input)
      ? readValue(input)
      : askForFix({ input, expected: NUMBER_EXPECTED, hint: NUMBER_HINT });
  }
  if (typeof input !== "string") {
    return askForFix({ input, expected: NUMBER_EXPECTED, hint: NUMBER_HINT });
  }

  const trimmed = input.trim();
  // Scientific notation first: its exponent marker is a letter, which the
  // currency strip below would remove.
  if (SCIENTIFIC_RE.test(trimmed)) {
    const exponential = Number(trimmed);
    // An exponent the double cannot hold ("1e999") parses as Infinity, which
    // is not a number a field can carry.
    return Number.isFinite(exponential)
      ? readValueAs(input, exponential)
      : askForFix({ input, expected: NUMBER_EXPECTED, hint: NUMBER_HINT });
  }

  const withoutCurrency = withoutCurrencyAffix(trimmed);
  if (withoutCurrency === null) {
    return askForFix({ input, expected: NUMBER_EXPECTED, hint: NUMBER_HINT });
  }
  const stripped = withoutCurrency
    .trim()
    .replace(ACCOUNTING_DASH_RE, "")
    .replace(GROUPING_SPACE_RE, "");
  if (!DIGITS_AND_SEPARATORS_RE.test(stripped)) {
    return askForFix({ input, expected: NUMBER_EXPECTED, hint: NUMBER_HINT });
  }

  const sign = stripped.startsWith("-") ? -1 : 1;
  const body = stripped.replace(/^[+-]/u, "");
  const commas = body.split(",").length - 1;
  const dots = body.split(".").length - 1;

  const decimalMark = ((): string | null | typeof AMBIGUOUS => {
    if (commas > 0 && dots > 0) {
      return lastSeparator(body);
    }
    if (commas + dots === 0) {
      return null;
    }
    if (commas > 1 || dots > 1) {
      return null;
    }
    const separator = commas === 1 ? "," : ".";
    if (!THREE_DIGIT_TAIL_RE.test(body)) {
      return separator;
    }
    const mark =
      options?.locale === undefined ? null : localeDecimalMark(options.locale);
    if (mark === null) {
      return AMBIGUOUS;
    }
    return mark === separator ? separator : null;
  })();

  if (decimalMark === AMBIGUOUS) {
    return ambiguousAsk(input, body, commas === 1 ? "," : ".");
  }

  const magnitude = toNumber(body, decimalMark);
  if (!Number.isFinite(magnitude)) {
    return askForFix({ input, expected: NUMBER_EXPECTED, hint: NUMBER_HINT });
  }
  return readValueAs(input, sign * magnitude);
};
