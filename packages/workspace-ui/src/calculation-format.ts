/**
 * Turning a calculation result into the two strings a view shows: the compact
 * line in the header, and the breakdown behind it.
 *
 * Formatting is separate from reducing because the reduction is the same
 * everywhere and the formatting is not: it needs the reader's locale, and a
 * monetary reduction has one line per currency to lay out.
 */

import { Result } from "better-result";

import type { CalculationResult } from "@stll/calculations";
import type { CentsAmount } from "@stll/money";

export type CalculationFormatters = {
  number: (value: number) => string;
  money: (amountCents: CentsAmount, currency: string) => string;
  percent: (ratio: number) => string;
};

export type CalculationLabels = {
  /** The reduction's short name, e.g. "Sum". */
  kind: string;
  /** Stands in for a value the reduction cannot produce. */
  unavailable: string;
};

export type FormattedCalculation = {
  /** One compact line, for the column header. */
  summary: string;
  /**
   * One line per currency, for the tooltip. Empty when the summary already
   * says everything: there is nothing to expand for a single unit.
   */
  breakdown: readonly string[];
};

export type FormatCalculationParams = {
  result: CalculationResult;
  formatters: CalculationFormatters;
  labels: CalculationLabels;
};

export const formatCalculationResult = ({
  result,
  formatters,
  labels,
}: FormatCalculationParams): FormattedCalculation => {
  switch (result.type) {
    case "count":
    case "number":
      return line(labels.kind, formatters.number(result.value));
    case "ratio":
      return line(labels.kind, formatters.percent(result.value));
    case "money": {
      const amounts = result.totals.map((total) =>
        formatters.money(total.amountCents, total.currency),
      );
      if (amounts.length === 0) {
        return line(labels.kind, labels.unavailable);
      }
      return {
        summary: `${labels.kind} ${amounts.join(SEPARATOR)}`,
        // A single currency needs no expansion; several do, because the
        // summary line is the first thing that has to fit in a column header.
        breakdown: amounts.length > 1 ? amounts : [],
      };
    }
    case "unsupported":
      return line(labels.kind, labels.unavailable);
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
};

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

const SEPARATOR = " · ";

const line = (kind: string, value: string): FormattedCalculation => ({
  summary: `${kind} ${value}`,
  breakdown: [],
});
