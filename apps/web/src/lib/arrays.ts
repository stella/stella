export const normalizeOptionalArray = <T>(value: T[] | undefined): T[] => {
  if (value === undefined) {
    return [];
  }

  return value;
};

/** Normalize an optional array without hiding whether absence is expected. */
export const optionalArray = <T>(value: T[] | null | undefined): T[] => {
  if (value === undefined || value === null) {
    return [];
  }
  return value;
};

export const optionalReadonlyArray = <T>(
  value: readonly T[] | null | undefined,
): readonly T[] => {
  if (value === undefined || value === null) {
    return [];
  }
  return value;
};
