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

import { Result } from "better-result";

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

export type ToMinorUnitsParams = {
  /** The amount in major units, as typed. */
  amount: number;
  currency: string;
};

/**
 * A typed major-unit amount as the minor units the currency actually counts:
 * 12.5 USD is 1250, 1500 JPY is 1500, 12.5 KWD is 12500.
 *
 * Rounding is the point: a decimal input carries more places than the currency
 * has, and the stored value must be an exact integer. A non-finite `amount`
 * panics through `cents()`, so a form parses and rejects its own input before
 * asking for a value to store.
 */
export const toMinorUnits = ({
  amount,
  currency,
}: ToMinorUnitsParams): CentsAmount =>
  cents(Math.round(amount * 10 ** currencyMinorUnitDigits(currency)));

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
