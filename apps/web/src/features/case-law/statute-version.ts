/**
 * Which consolidation of an act a citation was made against.
 *
 * A decision applies the wording in force when it was issued, and a citation
 * reference records that version's opening date. Following the reference to
 * today's wording would show the reader text the court never read — and an
 * anchor the current version may not even carry — so the version window is
 * matched here rather than assumed away.
 */

export type StatuteVersionWindow = {
  /** Opens the window; null for a work kept as a single unversioned text. */
  versionValidFrom: string | null;
  /** Closes it, exclusive; null while the version is the one in force. */
  versionValidTo: string | null;
};

/**
 * The corpus half-open interval `[from, to)`: a version whose successor opens
 * on a date ends on that date. Dates are ISO date-only, which orders
 * correctly as text.
 */
export const versionCoversDate = (
  version: StatuteVersionWindow,
  date: string,
): boolean =>
  (version.versionValidFrom === null || version.versionValidFrom <= date) &&
  (version.versionValidTo === null || version.versionValidTo > date);

/** The consolidation in force on `date`, or null when the corpus holds none. */
export const pickVersionAt = <TVersion extends StatuteVersionWindow>(
  versions: readonly TVersion[],
  date: string,
): TVersion | null =>
  versions.find((version) => versionCoversDate(version, date)) ?? null;
