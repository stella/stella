import { panic } from "better-result";

import { isRecord } from "@/api/lib/type-guards";

const JSON_NUMBER_MAX_BYTES = 25;
const JSON_ESCAPED_UTF8_BYTE_MAX_BYTES = 6;

const finiteBound = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return panic("Public response schema has no finite bound");
  }
  return value;
};

/** Conservative serialized JSON bound derived from a finite wire schema. */
export const responseByteBound = (schema: unknown): number => {
  if (!isRecord(schema)) {
    return panic("Public response schema must be an object");
  }
  if ("const" in schema) {
    return Buffer.byteLength(JSON.stringify(schema["const"]), "utf-8");
  }
  const alternatives = schema["anyOf"] ?? schema["oneOf"];
  if (Array.isArray(alternatives)) {
    return Math.max(...alternatives.map((branch) => responseByteBound(branch)));
  }
  if (Array.isArray(schema["enum"])) {
    return Math.max(
      ...schema["enum"].map((value) =>
        Buffer.byteLength(JSON.stringify(value), "utf-8"),
      ),
    );
  }
  switch (schema["type"]) {
    case "string": {
      const bytes = schema["x-maxUtf8Bytes"];
      const maxBytes =
        typeof bytes === "number"
          ? finiteBound(bytes)
          : finiteBound(schema["maxLength"]) * 4;
      return 2 + maxBytes * JSON_ESCAPED_UTF8_BYTE_MAX_BYTES;
    }
    case "number":
    case "integer":
      return JSON_NUMBER_MAX_BYTES;
    case "boolean":
      return "false".length;
    case "null":
      return "null".length;
    case "array": {
      const count = finiteBound(schema["maxItems"]);
      return (
        2 + count * responseByteBound(schema["items"]) + Math.max(0, count - 1)
      );
    }
    case "object": {
      const properties = schema["properties"];
      if (isRecord(properties)) {
        const entries = Object.entries(properties);
        return (
          2 +
          entries.reduce(
            (bytes, [key, value]) =>
              bytes +
              Buffer.byteLength(JSON.stringify(key), "utf-8") +
              1 +
              responseByteBound(value),
            0,
          ) +
          Math.max(0, entries.length - 1)
        );
      }
      const patterns = schema["patternProperties"];
      if (isRecord(patterns)) {
        const count = finiteBound(schema["maxProperties"]);
        const valueBytes = Math.max(
          ...Object.values(patterns).map((value) => responseByteBound(value)),
        );
        const keyBytes = responseByteBound(schema["propertyNames"]);
        return 2 + count * (keyBytes + 1 + valueBytes) + Math.max(0, count - 1);
      }
      return panic("Public response object has no finite property contract");
    }
    default:
      return panic(
        `Unsupported public response schema type: ${String(schema["type"])}`,
      );
  }
};
