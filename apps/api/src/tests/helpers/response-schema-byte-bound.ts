import { panic } from "better-result";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Conservative serialized JSON size, derived from the enforced wire schema. */
export const responseSchemaByteBound = (schema: unknown): number => {
  if (!isRecord(schema)) {
    return panic("A response byte bound requires a schema object");
  }
  if ("const" in schema) {
    return Buffer.byteLength(JSON.stringify(schema["const"]));
  }
  if (Array.isArray(schema["enum"])) {
    return Math.max(
      ...schema["enum"].map((value: unknown) =>
        Buffer.byteLength(JSON.stringify(value)),
      ),
    );
  }
  for (const keyword of ["anyOf", "oneOf"]) {
    if (Array.isArray(schema[keyword])) {
      return Math.max(...schema[keyword].map(responseSchemaByteBound));
    }
  }
  switch (schema["type"]) {
    case "string": {
      const utf8Bytes = schema["x-maxUtf8Bytes"];
      if (typeof utf8Bytes === "number") {
        return 2 + utf8Bytes * 6;
      }
      const chars = schema["maxLength"];
      if (typeof chars !== "number") {
        return panic(
          "A response string needs an enforced byte or character bound",
        );
      }
      return 2 + chars * 4 * 6;
    }
    case "number":
    case "integer":
      return 25;
    case "boolean":
      return 5;
    case "null":
      return 4;
    case "array": {
      const count = schema["maxItems"];
      if (typeof count !== "number") {
        return panic("A response array needs an enforced item bound");
      }
      return (
        2 +
        count * responseSchemaByteBound(schema["items"]) +
        Math.max(0, count - 1)
      );
    }
    case "object": {
      const properties = schema["properties"];
      if (!isRecord(properties) || schema["additionalProperties"] !== false) {
        return panic("A response object needs closed declared properties");
      }
      const fields = Object.entries(properties);
      return (
        2 +
        Math.max(0, fields.length - 1) +
        fields.reduce(
          (sum, [key, value]) =>
            sum +
            Buffer.byteLength(JSON.stringify(key)) +
            1 +
            responseSchemaByteBound(value),
          0,
        )
      );
    }
    default:
      return panic("A response byte bound cannot admit opaque payloads");
  }
};
