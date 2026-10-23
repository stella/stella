import { panic } from "better-result";
import type { GenericSchema } from "valibot";

import { toRouteJsonSchema } from "@/api/lib/json-schema/valibot-to-json-schema";
import { isRecord } from "@/api/lib/type-guards";

const JSON_NUMBER_MAX_BYTES = 25;
const JSON_ESCAPED_UTF8_BYTE_MAX_BYTES = 6;

/** Where in the response a node sits (`$.hits[].headline`), for the failure message. */
type SchemaPath = string;

const finiteBound = (
  value: unknown,
  path: SchemaPath,
  keyword: string,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return panic(
      `Public response schema has no finite ${keyword} at ${path}; bound it in the schema`,
    );
  }
  return value;
};

const jsonByteBound = (schema: unknown, path: SchemaPath = "$"): number => {
  if (!isRecord(schema)) {
    return panic(`Public response schema must be an object at ${path}`);
  }
  if ("const" in schema) {
    return Buffer.byteLength(JSON.stringify(schema["const"]), "utf-8");
  }
  const alternatives = schema["anyOf"] ?? schema["oneOf"];
  if (Array.isArray(alternatives)) {
    return Math.max(
      ...alternatives.map((branch) => jsonByteBound(branch, path)),
    );
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
          ? finiteBound(bytes, path, "x-maxUtf8Bytes")
          : finiteBound(schema["maxLength"], path, "maxLength") * 4;
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
      const count = finiteBound(schema["maxItems"], path, "maxItems");
      // A tuple renders its leading elements as a list (`items` in draft 07,
      // `prefixItems` in 2020-12) and the rest beside them; every element is
      // bounded by the largest of those.
      const prefix = schema["prefixItems"] ?? schema["items"];
      const rest = Array.isArray(schema["items"])
        ? schema["additionalItems"]
        : schema["items"];
      const elementSchemas = [
        ...(Array.isArray(prefix) ? prefix : []),
        ...(rest === undefined || Array.isArray(rest) ? [] : [rest]),
      ];
      const elementBytes = Math.max(
        ...elementSchemas.map((element) => jsonByteBound(element, `${path}[]`)),
      );
      return 2 + count * elementBytes + Math.max(0, count - 1);
    }
    case "object": {
      const properties = schema["properties"];
      const rest = schema["additionalProperties"];
      // A record: no declared properties, every key read by `propertyNames`
      // and every value by `additionalProperties`, at most `maxProperties`.
      if (properties === undefined && isRecord(rest)) {
        const count = finiteBound(
          schema["maxProperties"],
          path,
          "maxProperties",
        );
        const keyBytes = jsonByteBound(schema["propertyNames"], `${path}{key}`);
        return (
          2 +
          count * (keyBytes + 1 + jsonByteBound(rest, `${path}{value}`)) +
          Math.max(0, count - 1)
        );
      }
      // A response object drops undeclared properties; one that passes them
      // through needs a different envelope calculation, never a silent
      // underestimate.
      if (rest !== undefined && rest !== false) {
        return panic(
          `Public response object allows undeclared properties at ${path}`,
        );
      }
      if (isRecord(properties)) {
        const entries = Object.entries(properties);
        return (
          2 +
          entries.reduce(
            (bytes, [key, value]) =>
              bytes +
              Buffer.byteLength(JSON.stringify(key), "utf-8") +
              1 +
              jsonByteBound(value, `${path}.${key}`),
            0,
          ) +
          Math.max(0, entries.length - 1)
        );
      }
      const patterns = schema["patternProperties"];
      if (isRecord(patterns)) {
        const count = finiteBound(
          schema["maxProperties"],
          path,
          "maxProperties",
        );
        const valueBytes = Math.max(
          ...Object.values(patterns).map((value) =>
            jsonByteBound(value, `${path}{value}`),
          ),
        );
        const keyBytes = jsonByteBound(schema["propertyNames"], `${path}{key}`);
        return 2 + count * (keyBytes + 1 + valueBytes) + Math.max(0, count - 1);
      }
      return panic(
        `Public response object has no finite property contract at ${path}`,
      );
    }
    default:
      return panic(
        `Unsupported public response schema type ${String(schema["type"])} at ${path}`,
      );
  }
};

/** Conservative serialized JSON bound derived from a finite response schema. */
export const responseByteBound = (schema: GenericSchema): number =>
  jsonByteBound(toRouteJsonSchema(schema));
