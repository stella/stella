/**
 * Fold a surface form to its comparison key for the
 * excluded-canonicals filter. Mirrors Folio's
 * decoration matcher: NFKC + lowercase, with runs of
 * whitespace collapsed so "Acme  Corp" and "Acme Corp"
 * collide.
 */
export const normalizeForExclusion = (value: string): string =>
  value.normalize("NFKC").toLowerCase().replaceAll(/\s+/gu, " ").trim();
