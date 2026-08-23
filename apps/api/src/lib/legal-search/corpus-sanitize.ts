import { stripDangerousChars } from "@stll/legal-ast/text-sanitize";

import { isRecord } from "@/api/lib/type-guards";

export {
  DANGEROUS_CHARS,
  stripDangerousChars,
} from "@stll/legal-ast/text-sanitize";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonArray;
type JsonObject = {
  [key: string]: JsonPrimitive | JsonObject | JsonArray;
};
type JsonArray = JsonValue[];

const sanitizeMetadataValue = (value: unknown): JsonValue => {
  if (typeof value === "string") {
    return stripDangerousChars(value);
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetadataValue(item));
  }

  if (isRecord(value)) {
    const sanitized: JsonObject = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      sanitized[key] = sanitizeMetadataValue(nestedValue);
    }
    return sanitized;
  }

  return null;
};

export const sanitizeMetadata = (
  metadata: Record<string, unknown>,
): Record<string, unknown> => {
  const sanitized = sanitizeMetadataValue(metadata);
  return isRecord(sanitized) ? sanitized : {};
};
