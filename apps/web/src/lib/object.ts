export const typedEntries = <T extends Record<string, string>>(obj: T) =>
  // SAFETY: Object.entries preserves the exact key/value pairs from this record.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- typed Object.entries helper; runtime pairs match the key/value type by construction
  Object.entries(obj) as {
    [K in keyof T]: [K, T[K]];
  }[keyof T][];
