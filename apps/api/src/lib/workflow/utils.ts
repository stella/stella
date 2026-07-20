import {
  type ConditionNode,
  type ConditionValue,
  type OperandResolver,
  type RefOperand,
  evaluateCondition as evaluateConditionNode,
  pruneIncomplete,
} from "@stll/conditions";

import type { FieldContent } from "@/api/db/schema-validators";
import type { PropertyBatch } from "@/api/lib/workflow/get-execution-plan";

export const prepareBatch = (
  rawBatch: PropertyBatch,
  fieldContentMap: Map<string, FieldContent["type"]>,
  lockedPropertyIds: ReadonlySet<string> = new Set(),
  forcedPropertyIds: ReadonlySet<string> = new Set(),
): PropertyBatch => {
  const propertiesToProcess = rawBatch.properties.filter((prop) => {
    if (lockedPropertyIds.has(prop.id)) {
      return false;
    }

    if (forcedPropertyIds.has(prop.id)) {
      return true;
    }

    const fieldContentType = fieldContentMap.get(prop.id);

    return (
      prop.status !== "fresh" ||
      !fieldContentType ||
      fieldContentType === "error" ||
      fieldContentType === "pending" ||
      fieldContentType === "unsupported"
    );
  });

  return {
    ...rawBatch,
    properties: propertiesToProcess,
  };
};

/**
 * Projects a field's content onto a concrete condition value. Content
 * types that cannot gate (file, clip, error, pending, unsupported)
 * resolve to `undefined`, which the evaluator treats as empty/absent.
 */
export const fieldContentToValue = (content: FieldContent): ConditionValue => {
  switch (content.type) {
    case "text":
      return content.value;
    case "single-select":
      return content.value;
    case "multi-select":
      return content.value;
    case "int":
      return content.value;
    case "date":
      return content.value;
    case "file":
    case "clip":
    case "error":
    case "pending":
    case "unsupported":
      return undefined;
    default: {
      content satisfies never;
      return undefined;
    }
  }
};

/**
 * Builds an `OperandResolver` over the field contents available to a
 * batch row. Extraction gating only references the dependency property
 * by id, so a `property` operand resolves from the map; every other
 * operand kind (builtin/kind/path) is irrelevant here and resolves to
 * `undefined`.
 */
const buildGatingResolver =
  (
    fieldContentByPropertyId: ReadonlyMap<string, FieldContent>,
  ): OperandResolver =>
  (operand: RefOperand): ConditionValue => {
    if (operand.type !== "property") {
      return undefined;
    }
    const content = fieldContentByPropertyId.get(operand.propertyId);
    if (!content) {
      return undefined;
    }
    return fieldContentToValue(content);
  };

/**
 * Whether a dependent property's AI extraction should run, given the
 * gating condition and the field contents available to its batch.
 * A `null` condition always runs (no gate).
 */
export const evaluateGatingCondition = (
  condition: ConditionNode | null,
  fieldContentByPropertyId: ReadonlyMap<string, FieldContent>,
): boolean => {
  if (!condition) {
    return true;
  }
  // An incomplete gate (a leaf whose value was never entered) is no gate.
  const pruned = pruneIncomplete(condition);
  if (!pruned) {
    return true;
  }
  return evaluateConditionNode(
    pruned,
    buildGatingResolver(fieldContentByPropertyId),
  );
};
