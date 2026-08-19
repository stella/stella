/**
 * What a workspace field contributes to a column calculation, and which
 * reductions a property's values allow.
 *
 * The reducer works on a small value type rather than on fields, so this is the
 * one place that knows how a workspace field maps onto it.
 */

import type { CalculationKind, CalculationValue } from "@stll/calculations";
import { NUMERIC_CALCULATION_KINDS } from "@stll/calculations";
import { unsafeCents } from "@stll/money";
import { currencyMinorUnitDigits } from "@stll/workspace-ui/calculation-format";

import type { WorkspaceField, WorkspaceProperty } from "@/lib/types";

/** Reductions that count rows, which every property type supports. */
const COUNTING_KINDS = [
  "count",
  "count-filled",
  "count-empty",
  "count-unique",
  "percent-filled",
  "percent-empty",
] as const satisfies readonly CalculationKind[];

/**
 * A share of the view's total needs the view's total, and a column only ever
 * holds its own page of rows, so it is not offered until something can supply
 * the whole.
 */
const OFFERED_NUMERIC_KINDS = NUMERIC_CALCULATION_KINDS.filter(
  (kind) => kind !== "percent-of-total",
);

export const calculationKindsForProperty = (
  property: WorkspaceProperty,
): readonly CalculationKind[] =>
  property.content.type === "int"
    ? [...COUNTING_KINDS, ...OFFERED_NUMERIC_KINDS]
    : COUNTING_KINDS;

/** A property whose values can be reduced at all is worth offering. */
export const isCalculableProperty = (property: WorkspaceProperty): boolean =>
  property.content.type !== "file";

export const toCalculationValue = (
  field: WorkspaceField | undefined,
): CalculationValue => {
  if (!field) {
    return { type: "empty" };
  }

  switch (field.content.type) {
    case "int": {
      const { currency, value } = field.content;
      if (currency === null) {
        return { type: "number", value };
      }
      // The cell renderer formats an int's value as major units and the money
      // reduction counts minor ones, so the amount is scaled by the currency's
      // own exponent on the way in. Without it an int column holding two
      // currencies would add up to a number in neither of them.
      return {
        type: "money",
        amountCents: unsafeCents(
          Math.round(value * 10 ** currencyMinorUnitDigits(currency)),
        ),
        currency,
      };
    }
    case "text":
      return textValue(field.content.value);
    case "single-select":
      return textValue(field.content.value ?? "");
    case "multi-select":
      return textValue(field.content.value.join(", "));
    case "date":
      return textValue(field.content.value ?? "");
    case "clip":
      return textValue(field.content.url);
    case "file":
    case "error":
    case "pending":
    case "unsupported":
      return { type: "empty" };
    default: {
      const exhaustive: never = field.content;
      return exhaustive;
    }
  }
};

const textValue = (value: string): CalculationValue =>
  value.trim() === "" ? { type: "empty" } : { type: "text", value };
