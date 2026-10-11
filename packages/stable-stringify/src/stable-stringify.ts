/**
 * The input contract, as a type: JSON-shaped data (primitives, arrays, and
 * string-keyed plain objects) plus the four values JSON has no form for that
 * the serializer spells out.
 *
 * A `Date`, `Map`, or `Set` is deliberately outside it. Such a value would
 * serialize through its enumerable own string keys and read as `{}`, so
 * fingerprints of two different instances would collide; the type turns that
 * into a compile error at the call site instead. Callers fingerprint data
 * that already crossed a JSON boundary (tool-call arguments, review findings,
 * editor state), never live instances.
 */
export type StableStringifyInput =
  | bigint
  | boolean
  | number
  | string
  | symbol
  | null
  | undefined
  | ((...args: never[]) => unknown)
  | readonly StableStringifyInput[]
  | { readonly [key: string]: StableStringifyInput };

/** `Array.isArray` narrows to `any[]`, which would erase the element type on
 *  the way back into the recursion. */
const isInputArray = (
  value: StableStringifyInput,
): value is readonly StableStringifyInput[] => Array.isArray(value);

// Unquoted, this token is not valid JSON, so it cannot equal the
// serialization of any JSON value. Its spelling is a stable fingerprint format.
const CIRCULAR_REFERENCE_TOKEN = "[circular]";

/**
 * Deterministic serialization for hashing/keying JSON-shaped values:
 * canonical key order via plain UTF-16 code-unit comparison (the order of
 * JavaScript `<`, not localeCompare), so the output is bit-identical across
 * environments regardless of runtime/ICU locale.
 *
 * Callers compare fingerprints — the chat loop detector's tool-call
 * signatures, a review finding's identity, an editor's dirty check — so two
 * structurally equal values must stringify identically no matter which order
 * their keys were assembled in. Fingerprints are persisted, so neither the
 * input contract nor the output form widens.
 *
 * Values JSON has no form for are given one rather than dropped: `undefined`
 * (including an explicitly-undefined key, so it stays distinguishable from an
 * absent one), `bigint`, `symbol`, and functions. A cycle serializes as the
 * stable, non-JSON token `[circular]` instead of throwing, because a fingerprint
 * of a malformed value is still more useful than a crash on the path that
 * computes it. Only ancestors of the current value count as cycles; shared
 * non-circular references are serialized in full at each location.
 */
export const stableStringify = (
  value: StableStringifyInput,
  seen: WeakSet<object> = new WeakSet<object>(),
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
    return CIRCULAR_REFERENCE_TOKEN;
  }

  seen.add(value);
  if (isInputArray(value)) {
    const serialized = `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
    seen.delete(value);
    return serialized;
  }

  const serializedEntries: string[] = [];
  const orderedKeys = Object.entries(value).toSorted(([left], [right]) =>
    left < right ? -1 : Number(left > right),
  );
  for (const [key, entryValue] of orderedKeys) {
    serializedEntries.push(
      `${JSON.stringify(key)}:${stableStringify(entryValue, seen)}`,
    );
  }

  seen.delete(value);
  return `{${serializedEntries.join(",")}}`;
};
