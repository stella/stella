import type {
  FieldContent,
  PropertyCondition,
} from "@/api/db/schema-validators";
import type { PropertyBatch } from "@/api/lib/workflow/get-execution-plan";

export const prepareBatch = (
  rawBatch: PropertyBatch,
  fieldContentMap: Map<string, FieldContent["type"]>,
  lockedPropertyIds: ReadonlySet<string> = new Set(),
): PropertyBatch => {
  const propertiesToProcess = rawBatch.properties.filter((prop) => {
    if (lockedPropertyIds.has(prop.id)) {
      return false;
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

export const evaluateCondition = (
  fieldContent: FieldContent,
  condition: PropertyCondition,
): boolean => {
  if (
    fieldContent.type === "error" ||
    fieldContent.type === "pending" ||
    fieldContent.type === "unsupported" ||
    fieldContent.type === "file" ||
    fieldContent.type === "clip"
  ) {
    return false;
  }

  switch (condition.type) {
    case "string": {
      if (typeof fieldContent.value !== "string") {
        return false;
      }
      return evaluateStringCondition(condition, fieldContent.value);
    }
    case "string-array": {
      if (!Array.isArray(fieldContent.value)) {
        return false;
      }
      return evaluateStringArrayCondition(condition, fieldContent.value);
    }
    default:
      return false;
  }
};

type StringCondition = Extract<PropertyCondition, { type: "string" }>;

const evaluateStringCondition = (
  condition: StringCondition,
  fieldValue: string,
) => fieldValue === condition.value;

type StringArrayCondition = Extract<
  PropertyCondition,
  { type: "string-array" }
>;

const evaluateStringArrayCondition = (
  condition: StringArrayCondition,
  fieldValue: string[],
) => condition.value.every((v) => fieldValue.includes(v));
