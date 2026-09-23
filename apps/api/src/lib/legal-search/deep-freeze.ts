/**
 * Freezes a JSON-shaped value and everything it reaches, so a value shared
 * between callers throws on mutation instead of changing under the others.
 */
export const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== "object") {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  Object.freeze(value);
  return value;
};
