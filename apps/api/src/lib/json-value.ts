import { isRecord } from "@/api/lib/type-guards";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = {
  [key: string]: JsonValue;
};
export type JsonArray = JsonValue[];

export const toJsonValue = (value: unknown): JsonValue => {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }

  if (isRecord(value)) {
    return toJsonObject(value);
  }

  return null;
};

export const toJsonObject = (value: Record<string, unknown>): JsonObject => {
  const out: JsonObject = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    out[key] = toJsonValue(nestedValue);
  }
  return out;
};
