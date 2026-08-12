/**
 * Key-order-insensitive JSON fingerprint. Two structurally equal values
 * stringify identically no matter which order their keys were assembled in,
 * so a fingerprint survives a payload builder that spreads optional fields
 * conditionally. `undefined` is preserved rather than dropped, so an absent
 * key and an explicitly-undefined one still compare equal.
 */
export const stableStringify = (value: unknown): string => {
  if (value === undefined) {
    return "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.keys(value)
      .toSorted()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify(Reflect.get(value, key))}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
};
