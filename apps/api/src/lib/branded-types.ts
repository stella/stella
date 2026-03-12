declare const __brand: unique symbol;

type SafeIdType = "workspace" | "organization" | "contact" | "user";

export type SafeId<T extends SafeIdType> = string & {
  readonly [__brand]: T;
};

// SAFETY: SafeId is a nominal brand; runtime validation happens at call sites
export const toSafeId = <T extends SafeIdType>(value: string): SafeId<T> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  value as SafeId<T>;
