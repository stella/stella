/**
 * Rendering a stored minor-unit amount as text.
 *
 * The brand keeps the arithmetic honest; this keeps the display honest. Both
 * live here because "how many minor units make a major one" is a property of
 * the currency, and every surface that shows money has to answer it the same
 * way — a workspace column header, a billing summary, an invoice line.
 *
 * The locale is always a parameter. A package cannot read the reader's
 * formatting locale, and one that guessed would render a number differently
 * from the app around it.
 */

import { Result } from "better-result";

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

export type FormatMoneyCentsParams = {
  amountCents: number;
  currency: string;
  locale: string;
};

/**
 * Money is stored in minor units, and how many of them make a major one is a
 * property of the currency. Ask the currency rather than assuming a hundred.
 *
 * A code `Intl` rejects falls back to the amount beside the raw code: a column
 * showing "1500 A1C" is wrong-looking data, which is the truth, where a thrown
 * RangeError would take the whole board down with it.
 */
export const formatMoneyCents = ({
  amountCents,
  currency,
  locale,
}: FormatMoneyCentsParams): string => {
  const major = amountCents / 10 ** currencyMinorUnitDigits(currency);
  const formatted = Result.try(() =>
    new Intl.NumberFormat(locale, { style: "currency", currency }).format(
      major,
    ),
  );

  return formatted.isErr() ? `${major} ${currency}` : formatted.value;
};

export type FormatHundredthsParams = FormatMoneyCentsParams & {
  /** Digits to show, minimum and maximum alike. */
  fractionDigits: number;
};

/**
 * The same rendering with the minor unit fixed at a hundredth, and the shown
 * digits fixed by the caller.
 *
 * Wrong for a currency whose exponent is not 2 (JPY has 0, KWD has 3), and
 * kept only because billing amounts are stored on that assumption: changing
 * it is a money-model migration, not a formatting change. New surfaces call
 * `formatMoneyCents`, which asks the currency.
 */
export const formatHundredths = ({
  amountCents,
  currency,
  locale,
  fractionDigits,
}: FormatHundredthsParams): string => {
  const major = amountCents / 100;
  const formatted = Result.try(() =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(major),
  );

  return formatted.isErr()
    ? `${major.toFixed(fractionDigits)} ${currency}`
    : formatted.value;
};
