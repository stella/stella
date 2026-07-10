/**
 * Reads a stored extraction-gating condition back into the canonical
 * AST. Property dependencies persist a `ConditionNode | null`; legacy rows
 * used a condition that implicitly targeted the dependency's source property.
 */
import * as v from "valibot";

import {
  type ConditionNode,
  conditionHasFormula,
  conditionNodeSchema,
} from "@stll/conditions";

const legacyConditionSchema = v.variant("type", [
  v.strictObject({
    version: v.literal(1),
    type: v.literal("string"),
    operator: v.literal("eq"),
    value: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("string-array"),
    operator: v.literal("contains-every"),
    value: v.pipe(
      v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1000))),
      v.minLength(1),
    ),
  }),
]);

export type ParsedStoredCondition =
  | { status: "valid"; condition: ConditionNode | null }
  | { status: "invalid" };

export const parseStoredCondition = (
  value: unknown,
  dependsOnPropertyId: string,
): ParsedStoredCondition => {
  if (value === null || value === undefined) {
    return { status: "valid", condition: null };
  }
  if (v.is(conditionNodeSchema, value) && !conditionHasFormula(value)) {
    return { status: "valid", condition: value };
  }

  const legacy = v.safeParse(legacyConditionSchema, value);
  if (!legacy.success) {
    return { status: "invalid" };
  }
  if (legacy.output.type === "string-array") {
    return {
      status: "valid",
      condition: {
        type: "predicate",
        operand: { type: "property", propertyId: dependsOnPropertyId },
        op: "contains_all",
        value: legacy.output.value,
      },
    };
  }

  return {
    status: "valid",
    condition: {
      type: "compare",
      left: { type: "property", propertyId: dependsOnPropertyId },
      op: "eq",
      right: { type: "literal", value: legacy.output.value },
    },
  };
};
