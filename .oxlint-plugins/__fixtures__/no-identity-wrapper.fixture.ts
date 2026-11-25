// Passive regression fixture for `no-identity-wrapper/no-identity-wrapper`.

// oxlint-disable-next-line no-identity-wrapper/no-identity-wrapper -- fixture proves direct-called identity wrapper is flagged
const defineTable = <const T extends Record<string, string>>(table: T): T =>
  table;

export const TABLE = defineTable({ a: "1" });

// expect-clean: no-identity-wrapper/no-identity-wrapper
const asWritten = (value: string): string => value;

export const NORMALIZERS = { identity: asWritten };
