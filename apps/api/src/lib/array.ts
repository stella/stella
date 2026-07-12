export function arrayOrEmpty<T>(value: T[] | null | undefined): T[];
export function arrayOrEmpty<T>(
  value: readonly T[] | null | undefined,
): readonly T[];
export function arrayOrEmpty<T>(
  value: readonly T[] | null | undefined,
): readonly T[] {
  if (value === null || value === undefined) {
    return [];
  }
  return value;
}
