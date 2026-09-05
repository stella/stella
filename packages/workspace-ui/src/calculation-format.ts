/**
 * Turning a calculation result into the two strings a view shows: the compact
 * line in the header, and the breakdown behind it.
 *
 * Formatting is separate from reducing because the reduction is the same
 * everywhere and the formatting is not: it needs the reader's locale, and a
 * monetary reduction has one line per currency to lay out.
 */

import type { CalculationResult } from "@stll/calculations";
import type { CentsAmount } from "@stll/money";

// Money display belongs to the package that owns the amounts: the minor-unit
// question ("how many make a major one?") is a property of the currency, not
// of this kit. Re-exported here so the subpath consumers already import stays
// the one they import.
export {
  currencyMinorUnitDigits,
  formatMoneyCents,
  type FormatMoneyCentsParams,
} from "@stll/money";

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

const SEPARATOR = " · ";

const line = (kind: string, value: string): FormattedCalculation => ({
  summary: `${kind} ${value}`,
  breakdown: [],
});
