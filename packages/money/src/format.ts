/**
 * Moving between a stored minor-unit amount and the major-unit number a
 * person types, and rendering either as text.
 *
 * The brand keeps the arithmetic honest; this keeps the scale honest. Both
 * live here because "how many minor units make a major one" is a property of
 * the currency, and every surface that touches money has to answer it the
 * same way — a workspace column header, a billing form, an invoice line, an
 * export row.
 *
 * The locale is always a parameter. A package cannot read the reader's
 * formatting locale, and one that guessed would render a number differently
 * from the app around it.
 */

import { panic, Result } from "better-result";

import { type CentsAmount, cents } from "./cents";

/**
 * Two, the ISO 4217 default, used when a stored code is one `Intl` will not
 * accept. Validation at the API boundary keeps those out, but a row written
 * before that constraint existed must still render rather than throw.
 */
const DEFAULT_MINOR_UNIT_DIGITS = 2;

/**
 * How many minor units make a major one, for this currency: 100 for CZK, 1 for
 * JPY, 1000 for KWD. It is a property of the currency and not of the reader, so
 * the lookup is deliberately locale-independent.
 *
 * A malformed code makes the `Intl.NumberFormat` constructor throw, before any
 * `?? 2` on its result could help, so the fallback has to wrap the call.
 */
export const currencyMinorUnitDigits = (currency: string): number => {
  const resolved = Result.try(
    () =>
      new Intl.NumberFormat("en", {
        style: "currency",
        currency,
      }).resolvedOptions().maximumFractionDigits,
  );

  if (resolved.isErr()) {
    return DEFAULT_MINOR_UNIT_DIGITS;
  }
  return resolved.value ?? DEFAULT_MINOR_UNIT_DIGITS;
};

/** A decimal amount in major units: an optional sign, digits, an optional point. */
const DECIMAL_AMOUNT = /^(?<sign>[+-]?)(?<whole>\d*)(?:\.(?<fraction>\d*))?$/u;

/** Scientific notation, which `String(1e21)` and `String(1e-7)` both produce. */
const EXPONENT_AMOUNT =
  /^(?<sign>[+-]?)(?<whole>\d+)(?:\.(?<fraction>\d+))?[eE](?<exponent>[+-]?\d+)$/u;

/**
 * The widest exponent a finite double prints with (`5e-324`, `1.8e308`).
 * Text past it names no amount any currency stores, and expanding it would
 * mean materialising that many zeros.
 */
const MAX_EXPONENT_MAGNITUDE = 324;

const expandExponent = (text: string): string | null => {
  const groups = EXPONENT_AMOUNT.exec(text)?.groups;
  if (!groups) {
    return null;
  }
  const exponent = Number(groups["exponent"]);
  if (Math.abs(exponent) > MAX_EXPONENT_MAGNITUDE) {
    return null;
  }
  const sign = groups["sign"] ?? "";
  const digits = `${groups["whole"] ?? ""}${groups["fraction"] ?? ""}`;
  const point = (groups["whole"] ?? "").length + exponent;
  if (point <= 0) {
    return `${sign}0.${"0".repeat(-point)}${digits}`;
  }
  if (point >= digits.length) {
    return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  }
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
};

/**
 * The amount as decimal text, or null when it is not a decimal amount.
 *
 * A number is rendered by `String`, which produces the SHORTEST text that
 * round-trips back to the same double. That is what makes the number path
 * exact: the double nearest 1.005 prints as "1.005", which is the amount the
 * person typed, where multiplying that double by 100 yields 100.49999999999999.
 */
const decimalText = (amount: number | string): string | null => {
  if (typeof amount === "number") {
    if (!Number.isFinite(amount)) {
      return null;
    }
    const rendered = String(amount);
    return rendered.includes("e") ? expandExponent(rendered) : rendered;
  }
  const trimmed = amount.trim();
  return /[eE]/u.test(trimmed) ? expandExponent(trimmed) : trimmed;
};

/** The digits of a decimal amount, or null when the text is not one. */
const amountDigits = (
  amount: number | string,
): { sign: string; whole: string; fraction: string } | null => {
  const text = decimalText(amount);
  const groups = text === null ? undefined : DECIMAL_AMOUNT.exec(text)?.groups;
  if (groups === undefined) {
    return null;
  }
  const whole = groups["whole"] ?? "";
  const fraction = groups["fraction"] ?? "";
  if (`${whole}${fraction}`.length === 0) {
    return null;
  }
  return { sign: groups["sign"] ?? "", whole, fraction };
};

export type ToMinorUnitsParams = {
  /**
   * The amount in major units: the decimal text a form holds, or a number.
   * Text is preferred where the caller has it, because it is what the person
   * typed rather than the nearest double to it.
   */
  amount: number | string;
  currency: string;
};

/**
 * A typed major-unit amount as the minor units the currency actually counts:
 * 12.5 USD is 1250, 1500 JPY is 1500, 12.5 KWD is 12500.
 *
 * The scaling is decimal, not a float multiply. `1.005 * 100` is
 * 100.49999999999999 in binary floating point, so `Math.round` of it is 100
 * and a $1.005 line item silently loses a cent; the same shortfall appears at
 * a different decimal for every currency. Splitting the text on the point and
 * moving the digits instead keeps the amount the person typed: the kept
 * fraction digits are appended to the whole part, and the first digit dropped
 * decides a half-up carry on the magnitude.
 *
 * Rounding is still the point -- a typed amount carries more places than the
 * currency has -- and it happens on digits, exactly. Text this cannot parse,
 * and a result outside the safe integer range, are caller defects: gate the
 * text with `isDecimalAmount` first.
 */
export const toMinorUnits = (params: ToMinorUnitsParams): CentsAmount =>
  tryToMinorUnits(params) ??
  panic(
    `toMinorUnits(${JSON.stringify(params.amount)}): not an amount ${params.currency} can store`,
  );

/**
 * The same conversion for text nobody has vouched for yet: null when the text
 * is not a decimal amount, and null when the scaled value would leave the safe
 * integer range, where a total silently stops adding up.
 *
 * A form holds whatever was typed and has to be able to decline it. Everything
 * past that gate calls `toMinorUnits`, which panics, because by then the
 * decision has been made.
 */
export const tryToMinorUnits = ({
  amount,
  currency,
}: ToMinorUnitsParams): CentsAmount | null => {
  const parsed = amountDigits(amount);
  if (parsed === null) {
    return null;
  }

  const digits = currencyMinorUnitDigits(currency);
  const kept = parsed.fraction.slice(0, digits).padEnd(digits, "0");
  const dropped = parsed.fraction.charAt(digits);
  // Half-up on the magnitude: the sign is reattached after, so -0.005 and
  // 0.005 both move away from zero rather than both moving up.
  const magnitude =
    BigInt(`${parsed.whole || "0"}${kept}`) + (dropped >= "5" ? 1n : 0n);
  const value = Number(parsed.sign === "-" ? -magnitude : magnitude);

  return Number.isSafeInteger(value) ? cents(value) : null;
};

export type ToMajorUnitsParams = {
  amountCents: number;
  currency: string;
};

/** The inverse: a stored amount as the major-unit number a person reads. */
export const toMajorUnits = ({
  amountCents,
  currency,
}: ToMajorUnitsParams): number =>
  amountCents / 10 ** currencyMinorUnitDigits(currency);

export type FormatMoneyCentsParams = {
  amountCents: number;
  currency: string;
  locale: string;
  /**
   * Digits to show, minimum and maximum alike. Defaults to the currency's own
   * exponent; pass 0 for a rounded summary that has no room for decimals.
   */
  fractionDigits?: number;
};

/**
 * Money is stored in minor units, and how many of them make a major one is a
 * property of the currency. Ask the currency rather than assuming a hundred.
 *
 * A code `Intl` rejects falls back to the amount beside the raw code: a column
 * showing "15.00 A1C" is wrong-looking data, which is the truth, where a thrown
 * RangeError would take the whole board down with it.
 */
export const formatMoneyCents = ({
  amountCents,
  currency,
  locale,
  fractionDigits,
}: FormatMoneyCentsParams): string => {
  const major = toMajorUnits({ amountCents, currency });
  const digits = fractionDigits ?? currencyMinorUnitDigits(currency);
  const formatted = Result.try(() =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(major),
  );

  return formatted.isErr()
    ? `${major.toFixed(digits)} ${currency}`
    : formatted.value;
};
