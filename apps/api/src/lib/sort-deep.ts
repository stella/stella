/**
 * Recursively sorts object keys in ascending order.
 * Primitive values pass through unchanged; array element
 * order is preserved (elements are sorted recursively).
 */

type JsonObject = Record<string, unknown>;

const isPlainObject = (v: unknown): v is JsonObject =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  !(v instanceof Date) &&
  !(v instanceof RegExp);

export const sortDeep = (data: unknown): unknown => {
  if (Array.isArray(data)) {
    return data.map(sortDeep);
  }

  if (isPlainObject(data)) {
    const sorted: JsonObject = {};
    for (const key of Object.keys(data).toSorted()) {
      sorted[key] = sortDeep(data[key]);
    }
    return sorted;
  }

  return data;
};
