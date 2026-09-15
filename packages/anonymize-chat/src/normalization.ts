/** Fold a surface form to the comparison key used by anonymization filters. */
export const normalizeForExclusion = (value: string): string =>
  value.normalize("NFKC").toLowerCase().replaceAll(/\s+/gu, " ").trim();
