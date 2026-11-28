import { isTaggedError, Result } from "better-result";

/** Narrow `unknown` to a plain object (not null, not array). */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Type-narrowing `includes()` for readonly const arrays.
 * Avoids `as readonly string[]` widening at every call site.
 */
export const includes = <T extends string>(
  arr: readonly T[],
  value: string,
): value is T => arr.some((item) => item === value);

/** Binds a member tuple to its named-constant map. */
export type ConstantMap<T extends string> = { [K in T as ConstantName<K>]: K };

type ConstantName<S extends string> = S extends `${infer Head}-${infer Rest}`
  ? `${Uppercase<Head>}_${ConstantName<Rest>}`
  : Uppercase<S>;

/** Structural tag for a tagged error or standard Error without DB/logger coupling. */
export const taggedErrorTag = (error: unknown): string => {
  const tagged = Result.try(() =>
    isTaggedError(error) ? error._tag : undefined,
  ).unwrapOr(undefined);
  if (tagged !== undefined) {
    return tagged;
  }
  if (error instanceof Error && error.name !== "" && error.name !== "Error") {
    return error.name;
  }
  return "UnknownError";
};
