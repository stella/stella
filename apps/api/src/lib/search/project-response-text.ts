import { ElysiaCustomStatusResponse } from "elysia";

import { truncateTextBytes } from "@/api/lib/search/response-text-bounds";
import { isRecord } from "@/api/lib/type-guards";

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
  if (Array.isArray(branches)) {
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

/** Bound display text from the declared response contract, preserving stored data and cursors. */
export const projectResponseText = <T>(response: T, schema: unknown): T => {
  if (
    response instanceof ElysiaCustomStatusResponse ||
    response instanceof Response
  ) {
    return response;
  }
  const projected = structuredClone(response);
  project(projected, schema);
  return projected;
};
