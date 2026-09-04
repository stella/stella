/**
 * Column calculations: the reduction a view shows under (or beside) a column.
 *
 * The language is deliberately small and deliberately shared. A board's column
 * header and a table's footer row must agree on what "sum" means, or the same
 * rows read two different totals depending on which view is open; one reducer
 * is what makes that agreement structural rather than a convention.
 *
 * Money never crosses currencies. A monetary reduction returns one line per
 * currency (`MoneyTotals` buckets them), so there is no code path in which two
 * currencies silently add up to a number that means nothing.
 */

import { panic } from "better-result";

import { cents, MoneyTotals } from "@stll/money";
import type { CentsAmount, MoneyTotalsEntry } from "@stll/money";

export const CALCULATION_KINDS = [
  "count",
  "count-unique",
  "count-empty",
  "count-filled",
  "percent-empty",
  "percent-filled",
  "sum",
  "average",
  "median",
  "min",
  "max",
  "range",
  "percent-of-total",
] as const;

export type CalculationKind = (typeof CALCULATION_KINDS)[number];

/** Kinds that reduce the values themselves rather than counting rows. */
export const NUMERIC_CALCULATION_KINDS = [
  "sum",
  "average",
  "median",
  "min",
  "max",
  "range",
  "percent-of-total",
] as const;

export type NumericCalculationKind = (typeof NUMERIC_CALCULATION_KINDS)[number];

export const isNumericCalculationKind = (
  kind: CalculationKind,
): kind is NumericCalculationKind =>
  NUMERIC_CALCULATION_KINDS.some((candidate) => candidate === kind);

/**
 * One row's contribution to a calculation.
 *
 * A property renderer decides which arm a cell maps to. `empty` is its own arm
 * rather than a null value so "no value" is never confused with the number
 * zero, which is what makes count-empty and average disagree correctly.
 */
export type CalculationValue =
  | { type: "empty" }
  | { type: "number"; value: number }
  | { type: "money"; amountCents: CentsAmount; currency: string }
  | { type: "text"; value: string };

export type CalculationUnsupportedReason =
  /** A numeric reduction over values that are not numbers. */
  | "non-numeric"
  /** Numbers mixed with money, or money the reduction cannot combine. */
  | "mixed-units"
  /** A reduction that needs at least one value, over none. */
  | "no-values"
  /** A share of the whole, asked without being told what the whole is. */
  | "no-scope";

export type CalculationResult =
  /** A number of rows. */
  | { type: "count"; kind: CalculationKind; value: number }
  /** A share between 0 and 1. */
  | { type: "ratio"; kind: CalculationKind; value: number }
  /** A plain number in the property's own unit. */
  | { type: "number"; kind: CalculationKind; value: number }
  /** One amount per currency, sorted by currency code. */
  | {
      type: "money";
      kind: CalculationKind;
      totals: readonly MoneyTotalsEntry[];
    }
  | {
      type: "unsupported";
      kind: CalculationKind;
      reason: CalculationUnsupportedReason;
    };

export type RunCalculationParams = {
  kind: CalculationKind;
  /** The values in the column, in row order. */
  values: readonly CalculationValue[];
  /**
   * Every value in the view, for a reduction relative to the whole
   * (percent-of-total). Omitting it is not "relative to itself" — that answer
   * is always 100% and always meaningless — so percent-of-total without a
   * scope is unsupported rather than wrong.
   */
  scopeValues?: readonly CalculationValue[] | undefined;
};

export const runCalculation = ({
  kind,
  values,
  scopeValues,
}: RunCalculationParams): CalculationResult => {
  switch (kind) {
    case "count":
      return { type: "count", kind, value: values.length };
    case "count-empty":
      return { type: "count", kind, value: countEmpty(values) };
    case "count-filled":
      return { type: "count", kind, value: values.length - countEmpty(values) };
    case "count-unique":
      return { type: "count", kind, value: countUnique(values) };
    case "percent-empty":
      return { type: "ratio", kind, value: share(countEmpty(values), values) };
    case "percent-filled":
      return {
        type: "ratio",
        kind,
        value: share(values.length - countEmpty(values), values),
      };
    case "sum":
    case "average":
    case "median":
    case "min":
    case "max":
    case "range":
      return reduceNumeric(kind, values);
    case "percent-of-total":
      return scopeValues === undefined
        ? { type: "unsupported", kind, reason: "no-scope" }
        : percentOfTotal(kind, values, scopeValues);
    default: {
      kind satisfies never;
      return panic(`Unhandled kind: ${String(kind)}`);
    }
  }
};

const countEmpty = (values: readonly CalculationValue[]): number =>
  values.filter((value) => value.type === "empty").length;

const share = (part: number, values: readonly CalculationValue[]): number =>
  values.length === 0 ? 0 : part / values.length;

/**
 * Distinctness key. Money is keyed by currency and amount together, so 100 CZK
 * and 100 EUR are two values, not one.
 */
const uniqueKey = (value: CalculationValue): string | null => {
  switch (value.type) {
    case "empty":
      return null;
    case "number":
      return `n:${value.value}`;
    case "money":
      return `m:${value.currency}:${value.amountCents}`;
    case "text":
      return `t:${value.value}`;
    default: {
      value satisfies never;
      return panic(`Unhandled value: ${String(value)}`);
    }
  }
};

const countUnique = (values: readonly CalculationValue[]): number => {
  const seen = new Set<string>();
  for (const value of values) {
    const key = uniqueKey(value);
    if (key !== null) {
      seen.add(key);
    }
  }
  return seen.size;
};

type NumericValues =
  | { type: "numbers"; values: number[] }
  | { type: "money"; buckets: Map<string, number[]> }
  | { type: "unsupported"; reason: CalculationUnsupportedReason };

/**
 * Split the non-empty values into a single unit, or say why they have none.
 * Numbers and money together are the interesting failure: each side is
 * reducible on its own, and combining them would produce a number whose unit
 * nobody can name.
 */
const classify = (values: readonly CalculationValue[]): NumericValues => {
  const numbers: number[] = [];
  const buckets = new Map<string, number[]>();

  for (const value of values) {
    switch (value.type) {
      case "empty":
        break;
      case "text":
        return { type: "unsupported", reason: "non-numeric" };
      case "number":
        numbers.push(value.value);
        break;
      case "money": {
        const bucket = buckets.get(value.currency);
        if (bucket) {
          bucket.push(value.amountCents);
        } else {
          buckets.set(value.currency, [value.amountCents]);
        }
        break;
      }
      default: {
        value satisfies never;
        return panic(`Unhandled value: ${String(value)}`);
      }
    }
  }

  if (numbers.length > 0 && buckets.size > 0) {
    return { type: "unsupported", reason: "mixed-units" };
  }
  if (buckets.size > 0) {
    return { type: "money", buckets };
  }
  if (numbers.length > 0) {
    return { type: "numbers", values: numbers };
  }
  return { type: "unsupported", reason: "no-values" };
};

type NumericReducer = (values: readonly number[]) => number;

const REDUCERS = {
  sum: (values) => values.reduce((total, value) => total + value, 0),
  average: (values) =>
    values.reduce((total, value) => total + value, 0) / values.length,
  median: (values) => {
    const sorted = [...values].toSorted((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const upper = sorted[middle] ?? 0;
    if (sorted.length % 2 === 1) {
      return upper;
    }
    return ((sorted[middle - 1] ?? 0) + upper) / 2;
  },
  min: (values) => Math.min(...values),
  max: (values) => Math.max(...values),
  range: (values) => Math.max(...values) - Math.min(...values),
} as const satisfies Record<
  Exclude<NumericCalculationKind, "percent-of-total">,
  NumericReducer
>;

const reduceNumeric = (
  kind: Exclude<NumericCalculationKind, "percent-of-total">,
  values: readonly CalculationValue[],
): CalculationResult => {
  const classified = classify(values);

  switch (classified.type) {
    case "unsupported":
      // A sum with nothing to add is zero, in whatever unit the column holds.
      // Every other reduction needs a value to reduce.
      if (kind === "sum" && classified.reason === "no-values") {
        return { type: "number", kind, value: 0 };
      }
      return { type: "unsupported", kind, reason: classified.reason };
    case "numbers":
      return { type: "number", kind, value: REDUCERS[kind](classified.values) };
    case "money": {
      const totals = new MoneyTotals();
      for (const [currency, amounts] of classified.buckets) {
        // Minor units are integers; an average or a median can land between
        // two of them, so the reduction rounds to the nearest minor unit.
        totals.add(currency, cents(Math.round(REDUCERS[kind](amounts))));
      }
      return { type: "money", kind, totals: totals.entries() };
    }
    default: {
      classified satisfies never;
      return panic(`Unhandled classified: ${String(classified)}`);
    }
  }
};

/**
 * The column's total as a share of the view's total.
 *
 * A ratio only means something when both totals are counted in the same thing,
 * so each side carries its unit out of `singleTotal` and a mismatch is rejected
 * rather than divided: 100 EUR of a 100 CZK whole is not "all of it", and five
 * of a hundred euros is not five percent.
 */
const percentOfTotal = (
  kind: CalculationKind,
  values: readonly CalculationValue[],
  scopeValues: readonly CalculationValue[],
): CalculationResult => {
  const part = singleTotal(values);
  const whole = singleTotal(scopeValues);

  if (whole.type === "unsupported") {
    return { type: "unsupported", kind, reason: whole.reason };
  }
  if (part.type === "unsupported" && part.reason !== "no-values") {
    return { type: "unsupported", kind, reason: part.reason };
  }
  // An empty column has no unit of its own, so it takes the whole's and
  // contributes nothing; any other disagreement is a mismatch.
  if (part.type === "total" && part.unit !== whole.unit) {
    return { type: "unsupported", kind, reason: "mixed-units" };
  }
  if (whole.value === 0) {
    return { type: "unsupported", kind, reason: "no-values" };
  }

  const partValue = part.type === "unsupported" ? 0 : part.value;
  return { type: "ratio", kind, value: partValue / whole.value };
};

/**
 * A total plus what it is counted in: `"number"` for a plain quantity, the
 * currency code for money. Two totals are comparable only when their units
 * match.
 */
type TotalUnit = "number" | (string & Record<never, never>);

type SingleTotal =
  | { type: "total"; value: number; unit: TotalUnit }
  | { type: "unsupported"; reason: CalculationUnsupportedReason };

const singleTotal = (values: readonly CalculationValue[]): SingleTotal => {
  const classified = classify(values);

  switch (classified.type) {
    case "unsupported":
      return { type: "unsupported", reason: classified.reason };
    case "numbers":
      return {
        type: "total",
        value: REDUCERS.sum(classified.values),
        unit: "number",
      };
    case "money": {
      if (classified.buckets.size > 1) {
        return { type: "unsupported", reason: "mixed-units" };
      }
      const [currency, amounts] = [...classified.buckets.entries()].at(0) ?? [
        "",
        [],
      ];
      return { type: "total", value: REDUCERS.sum(amounts), unit: currency };
    }
    default: {
      classified satisfies never;
      return panic(`Unhandled classified: ${String(classified)}`);
    }
  }
};

export type { CentsAmount, MoneyTotalsEntry };
