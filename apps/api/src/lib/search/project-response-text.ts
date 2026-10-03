import { ElysiaCustomStatusResponse } from "elysia";

import { truncateTextBytes } from "@/api/lib/search/response-text-bounds";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const matchesBranch = (
  value: unknown,
  schema: Record<string, unknown>,
): boolean => {
  if ("const" in schema) {
    return value === schema["const"];
  }
  if (schema["type"] === "null") {
    return value === null;
  }
  if (schema["type"] === "string") {
    return typeof value === "string";
  }
  if (schema["type"] === "object") {
    if (!isRecord(value)) {
      return false;
    }
    const properties = schema["properties"];
    if (!isRecord(properties)) {
      return true;
    }
    return Object.entries(properties).every(
      ([key, property]) =>
        !isRecord(property) ||
        !("const" in property) ||
        value[key] === property["const"],
    );
  }
  return true;
};

const project = (value: unknown, schema: unknown): unknown => {
  if (!isRecord(schema)) {
    return value;
  }
  const branches = schema["anyOf"];
  if (isUnknownArray(branches)) {
    const branch = branches.find(
      (candidate) => isRecord(candidate) && matchesBranch(value, candidate),
    );
    return project(value, branch);
  }
  const cap = schema["x-maxUtf8Bytes"];
  if (typeof value === "string" && typeof cap === "number") {
    return truncateTextBytes(value, cap);
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      value[index] = project(item, schema["items"]);
    }
    return value;
  }
  const properties = schema["properties"];
  if (isRecord(value) && isRecord(properties)) {
    for (const [key, property] of Object.entries(properties)) {
      if (key in value) {
        value[key] = project(value[key], property);
      }
    }
  }
  return value;
};

/**
 * The wire copy of a value: arrays and properties lose `readonly`. Status
 * responses and `Response` objects pass through unchanged, as they do below,
 * and so do primitives, including branded ones such as `SafeId`.
 */
type DeepMutable<T> =
  T extends ElysiaCustomStatusResponse<infer _Code, infer _Body, infer _Status>
    ? T
    : T extends Response | string | number | boolean | bigint | null | undefined
      ? T
      : T extends readonly (infer Item)[]
        ? DeepMutable<Item>[]
        : T extends object
          ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
          : T;

/** Bound display text from the declared response contract, preserving stored data and cursors. */
export const projectResponseText = <T>(
  response: T,
  schema: unknown,
): DeepMutable<T> => {
  const projected =
    response instanceof ElysiaCustomStatusResponse ||
    response instanceof Response
      ? response
      : project(structuredClone(response), schema);
  // SAFETY: a status response or Response passes through and DeepMutable maps
  // its type to itself; every other value is a fresh structuredClone deep copy
  // owned by this call, so dropping readonly cannot alias the caller's data.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- reviewed: fresh deep copy, see SAFETY
  return projected as DeepMutable<T>;
};
