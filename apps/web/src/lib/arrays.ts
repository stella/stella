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

// Body mirrors optionalArray by design (same runtime); the readonly input/
// output signature is the meaningful difference. The null/undefined checks are
// ordered differently so this does not read as an accidental duplicate.
export const optionalReadonlyArray = <T>(
  value: readonly T[] | null | undefined,
): readonly T[] => {
  if (value === null || value === undefined) {
    return [];
  }
  return value;
};
