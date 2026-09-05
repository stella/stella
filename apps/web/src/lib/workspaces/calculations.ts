/**
 * What a workspace field contributes to a column calculation, and which
 * reductions a property's values allow.
 *
 * The reducer works on a small value type rather than on fields, so this is the
 * one place that knows how a workspace field maps onto it.
 */

import { panic } from "better-result";

import type { CalculationKind, CalculationValue } from "@stll/calculations";
import { NUMERIC_CALCULATION_KINDS } from "@stll/calculations";
import { toMinorUnits, unsafeCents } from "@stll/money";

import type {
  EntityKind,
  WorkspaceField,
  WorkspaceProperty,
} from "@/lib/types";

/** Reductions that count rows, which every property type supports. */
const COUNTING_KINDS = [
  "count",
  "count-filled",
  "count-empty",
  "count-unique",
  "percent-filled",
  "percent-empty",
] as const satisfies readonly CalculationKind[];

const NUMERIC_PROPERTY_TYPES = ["int", "money"] as const;

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
  NUMERIC_PROPERTY_TYPES.some((type) => type === property.content.type)
    ? [...COUNTING_KINDS, ...OFFERED_NUMERIC_KINDS]
    : COUNTING_KINDS;

/** A property whose values can be reduced at all is worth offering. */
export const isCalculableProperty = (property: WorkspaceProperty): boolean =>
  property.content.type !== "file";

/**
 * Whether a property applies to any of the kinds a view shows. A property
 * with no kind scope applies everywhere; a view with no kind restriction
 * shows everything. A board of tasks must not offer a totals column for a
 * property that only documents carry: the column would count nothing.
 */
export const propertyAppliesToKinds = (
  property: Pick<WorkspaceProperty, "kinds">,
  kinds: readonly EntityKind[] | null,
): boolean =>
  kinds === null ||
  property.kinds === null ||
  property.kinds.some((kind) => kinds.includes(kind));

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
      // own exponent on the way in. A money field needs no scaling: it already
      // stores minor units, which is the point of it being its own type.
      return {
        type: "money",
        amountCents: toMinorUnits({ amount: value, currency }),
        currency,
      };
    }
    case "money":
      return {
        type: "money",
        amountCents: unsafeCents(field.content.amountCents),
        currency: field.content.currency,
      };
    case "person":
      return textValue(field.content.name);
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
      field.content satisfies never;
      return panic(`Unhandled content: ${String(field.content)}`);
    }
  }
};

const textValue = (value: string): CalculationValue =>
  value.trim() === "" ? { type: "empty" } : { type: "text", value };
