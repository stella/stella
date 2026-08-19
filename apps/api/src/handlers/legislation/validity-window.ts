import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

/** Works with no version window sort below every dated consolidation. */
export const UNVERSIONED_SORT_DATE = "0001-01-01";

/**
 * A version window that covers the given date. The window is the corpus
 * half-open interval `[version_valid_from, version_valid_to)`, so a version
 * whose successor opens on that date has already ended on it. A null
 * `version_valid_from` marks a work kept as a single unversioned text, which
 * covers every date.
 *
 * Every read that answers "which text applied then" builds on this one
 * predicate: the listing (at `CURRENT_DATE`) and the point-in-time read (at a
 * caller-supplied date) must not be able to disagree about a boundary.
 */
export const inForceOn = (
  validFrom: SQLWrapper,
  validTo: SQLWrapper,
  asOf: SQLWrapper,
): SQL => sql`(
  ${validFrom} IS NULL OR ${validFrom} <= ${asOf}
) AND (
  ${validTo} IS NULL OR ${validTo} > ${asOf}
)`;

/** `inForceOn` evaluated at the database's current date. */
export const inForceToday = (validFrom: SQLWrapper, validTo: SQLWrapper): SQL =>
  inForceOn(validFrom, validTo, sql`CURRENT_DATE`);

/**
 * The sort key versions are ordered and keyset-paged by: the window opening,
 * with unversioned works below every dated consolidation.
 */
export const versionSortKey = (validFrom: SQLWrapper): SQL =>
  sql`coalesce(${validFrom}, DATE '${sql.raw(UNVERSIONED_SORT_DATE)}')`;
