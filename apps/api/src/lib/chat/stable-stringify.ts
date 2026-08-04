/**
 * Deterministic serialization for hashing/keying arbitrary values: canonical
 * key order via plain codepoint comparison (not localeCompare), so the output
 * is bit-identical across environments regardless of runtime/ICU locale.
 * Shared by the chat loop detector's tool-call signatures and the tool defect
 * memo's tool+args keys, which must agree on what "the same call" means.
 */
export const stableStringify = (
  value: unknown,
  seen = new WeakSet<object>(),
): string => {
  if (value === null) {
    return "null";
  }

  if (
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : String(value);
  }

  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }

  if (value === undefined) {
    return "undefined";
  }

  if (typeof value === "symbol") {
    return value.toString();
  }

  if (typeof value === "function") {
    return `[function ${value.name || "anonymous"}]`;
  }

  if (seen.has(value)) {
    return "[circular]";
  }

  seen.add(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
  }

  const serializedEntries: string[] = [];
  const orderedKeys = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : Number(left > right),
  );
  for (const [key, entryValue] of orderedKeys) {
    serializedEntries.push(
      `${JSON.stringify(key)}:${stableStringify(entryValue, seen)}`,
    );
  }

  return `{${serializedEntries.join(",")}}`;
};
