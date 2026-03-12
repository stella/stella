declare const __brand: unique symbol;

type SafeIdType = "workspace" | "organization" | "contact" | "user";

export type SafeId<T extends SafeIdType> = string & {
  readonly [__brand]: T;
};

export const toSafeId = <T extends SafeIdType>(value: string): SafeId<T> =>
  value as SafeId<T>;
