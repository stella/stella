import {
  currencyMinorUnitDigits,
  toMajorUnits,
  tryToMinorUnits,
} from "@stll/money";

/**
 * How a billing form moves between the amount it stores and the text it edits.
 *
 * The input holds MAJOR units, because that is what a person types, and the
 * currency input sits beside it and can still change afterwards. Scaling on
 * every keystroke would leave the stored amount pinned to whichever currency
 * happened to be selected while the digits were entered, so the conversion
 * waits for the currency the form actually submits.
 */

/**
 * The stored amount as the decimal text the input edits, at the number of
 * places the currency counts: a yen amount shows none, a dinar amount three.
 */
export const majorUnitInput = (amountCents: number, currency: string): string =>
  toMajorUnits({ amountCents, currency }).toFixed(
    currencyMinorUnitDigits(currency),
  );

export type SubmittedRateParams = {
  /** The major-unit text the rate input holds, or null when it is not overridden. */
  draft: string | null;
  /** The currency the form is submitting. */
  currency: string;
  /** The rate the form already carries, in minor units of that currency. */
  resolvedRateCents: number;
};

/**
 * The rate a time entry is submitted with.
 *
 * 100 typed while the currency read USD and submitted after it was changed to
 * JPY is 100 yen, not 10 000: a zero-exponent currency counts whole units, and
 * the digits the person entered are the major-unit amount either way.
 *
 * A draft the currency cannot express falls back to the rate already carried,
 * which is what the input last normalized to or what rate resolution supplied.
 */
export const submittedRateCents = ({
  draft,
  currency,
  resolvedRateCents,
}: SubmittedRateParams): number =>
  draft === null
    ? resolvedRateCents
    : (tryToMinorUnits({ amount: draft, currency }) ?? resolvedRateCents);
