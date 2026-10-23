import { panic } from "better-result";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

const schemaPropertyAtPath = (
  schema: unknown,
  [key, ...rest]: readonly string[],
): unknown => {
  if (key === undefined || !isRecord(schema)) {
    return schema;
  }
  const alternatives = schema["anyOf"];
  if (isUnknownArray(alternatives)) {
    const branch = alternatives.find(
      (candidate) =>
        isRecord(candidate) &&
        isRecord(candidate["properties"]) &&
        key in candidate["properties"],
    );
    return schemaPropertyAtPath(branch, [key, ...rest]);
  }
  const properties = schema["properties"];
  return schemaPropertyAtPath(
    isRecord(properties) ? properties[key] : undefined,
    rest,
  );
};

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
      // A strict object renders `additionalProperties: false`; a stripping
      // one renders none, and the response encoder sends only its declared
      // keys. A loose object passes undeclared keys through.
      const rest = schema["additionalProperties"];
      if (!isRecord(properties) || (rest !== undefined && rest !== false)) {
        return panic("A response object needs closed declared properties");
      }
      const fields = Object.entries(properties);
      const ordinaryBound =
        2 +
        Math.max(0, fields.length - 1) +
        fields.reduce(
          (sum, [key, value]) =>
            sum +
            Buffer.byteLength(JSON.stringify(key)) +
            1 +
            responseSchemaByteBound(value),
          0,
        );
      const sharedItems = schema["x-sharedArrayItems"];
      if (!isRecord(sharedItems)) {
        return ordinaryBound;
      }
      const arrayProperty = sharedItems["arrayProperty"];
      const nestedArrayPath = sharedItems["nestedArrayPath"];
      const maxItems = sharedItems["maxItems"];
      const outerArray =
        typeof arrayProperty === "string" ? properties[arrayProperty] : null;
      if (
        !isRecord(outerArray) ||
        typeof outerArray["maxItems"] !== "number" ||
        !Array.isArray(nestedArrayPath) ||
        !nestedArrayPath.every((part) => typeof part === "string") ||
        typeof maxItems !== "number"
      ) {
        return panic("A shared response array budget is malformed");
      }
      const nestedArray = schemaPropertyAtPath(
        outerArray["items"],
        nestedArrayPath,
      );
      if (
        !isRecord(nestedArray) ||
        typeof nestedArray["maxItems"] !== "number"
      ) {
        return panic("A shared response array budget must name an array");
      }
      const itemBound = responseSchemaByteBound(nestedArray["items"]);
      const nestedMax = nestedArray["maxItems"];
      const nestedVariableBound =
        nestedMax * itemBound + Math.max(0, nestedMax - 1);
      const sharedVariableBound =
        maxItems * itemBound + Math.max(0, maxItems - 1);
      return (
        ordinaryBound -
        outerArray["maxItems"] * nestedVariableBound +
        sharedVariableBound
      );
    }
    default:
      return panic("A response byte bound cannot admit opaque payloads");
  }
};
