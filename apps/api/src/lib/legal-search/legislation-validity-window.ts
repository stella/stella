import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

import {
  LEGISLATION_APPLICABLE_EXPRESSION_KINDS,
  LEGISLATION_APPLICABLE_WINDOW_DISPOSITION,
} from "@stll/api-contract/legislation-expression";

/** Works with no version window sort below every dated consolidation. */
export const UNVERSIONED_SORT_DATE = "0001-01-01";

/**
 * The sort key versions are ordered and keyset-paged by: the window opening,
 * with unversioned works below every dated consolidation.
 */
export const versionSortKey = (validFrom: SQLWrapper): SQL =>
  sql`coalesce(${validFrom}, DATE '${sql.raw(UNVERSIONED_SORT_DATE)}')`;

/**
 * A stored version as an applicability read sees it: its window and the two
 * fields that decide whether that window may answer at all. Every read that
 * asks "which text applied then" takes the whole reference, so a window can
 * never be matched against a date without its disposition and kind.
 */
export type LegislationVersionRef = {
  validFrom: SQLWrapper;
  validTo: SQLWrapper;
  disposition: SQLWrapper;
  kind: SQLWrapper;
};

type LegislationVersionColumns = {
  versionValidFrom: SQLWrapper;
  versionValidTo: SQLWrapper;
  windowDisposition: SQLWrapper;
  expressionKind: SQLWrapper;
};

/** The reference for `legislation_documents` or a Drizzle alias of it. */
export const legislationVersionRef = (
  table: LegislationVersionColumns,
): LegislationVersionRef => ({
  validFrom: table.versionValidFrom,
  validTo: table.versionValidTo,
  disposition: table.windowDisposition,
  kind: table.expressionKind,
});

const SQL_ALIAS = /^[a-z_][a-z0-9_]*$/u;

/**
 * The reference for a `legislation_documents` row bound to a table alias in
 * hand-written SQL (`FROM legislation_documents AS newer`).
 */
export const legislationVersionRefAt = (
  tableAlias: string,
): LegislationVersionRef => {
  if (!SQL_ALIAS.test(tableAlias)) {
    return panic(`Not a SQL table alias: ${tableAlias}`);
  }
  return {
    validFrom: sql.raw(`${tableAlias}.version_valid_from`),
    validTo: sql.raw(`${tableAlias}.version_valid_to`),
    disposition: sql.raw(`${tableAlias}.window_disposition`),
    kind: sql.raw(`${tableAlias}.expression_kind`),
  };
};

const APPLICABLE_KINDS_SQL = sql.raw(
  LEGISLATION_APPLICABLE_EXPRESSION_KINDS.map((kind) => `'${kind}'`).join(", "),
);
const APPLICABLE_DISPOSITION_SQL = sql.raw(
  `'${LEGISLATION_APPLICABLE_WINDOW_DISPOSITION}'`,
);

/**
 * Whether a version can answer a point-in-time read at all: an effective
 * window of an applicable kind. The SQL twin of
 * `isEligibleLegislationExpression`, built from the same constants.
 *
 * A version that fails it (never in force, an inconsistent publisher window,
 * a withdrawn tombstone, a promulgated text) stays readable as history, but
 * no applicability read may return it, count it or let it hide another.
 */
export const eligibleExpression = (ref: LegislationVersionRef): SQL => sql`(
  ${ref.disposition} = ${APPLICABLE_DISPOSITION_SQL}
  AND ${ref.kind} IN (${APPLICABLE_KINDS_SQL})
)`;

/**
 * Whether a version is still listed by its publisher. A withdrawn version is a
 * tombstone: openable by its id, labelled, and absent from every listing and
 * default.
 */
export const notWithdrawn = (ref: LegislationVersionRef): SQL =>
  sql`(${ref.disposition} <> ${sql.raw(`'withdrawn'`)})`;

/**
 * Whether a version's kind can answer for its Work at all, whatever its
 * window: a promulgated text never does.
 */
export const applicableKind = (ref: LegislationVersionRef): SQL =>
  sql`(${ref.kind} IN (${APPLICABLE_KINDS_SQL}))`;

/**
 * Whether the version's window has opened by `asOf`. A null opening marks a
 * work kept as one unversioned text, or a version whose publisher gave no
 * start: either sorts below every dated version (`versionSortKey`).
 */
export const openedBy = (ref: LegislationVersionRef, asOf: SQLWrapper): SQL =>
  sql`(${ref.validFrom} IS NULL OR ${ref.validFrom} <= ${asOf})`;

/**
 * Whether the version has a stated opening on or before `date`. Unlike
 * `openedBy`, a version with no opening never qualifies: counts of dated
 * wordings are built on it.
 */
export const opensOnOrBefore = (
  ref: LegislationVersionRef,
  date: SQLWrapper,
): SQL => sql`(${ref.validFrom} <= ${date})`;

/** Whether the version has a stated opening strictly before `date`. */
export const opensBefore = (
  ref: LegislationVersionRef,
  date: SQLWrapper,
): SQL => sql`(${ref.validFrom} < ${date})`;

/** Whether the version's window opens after `asOf`. */
export const opensAfter = (ref: LegislationVersionRef, asOf: SQLWrapper): SQL =>
  sql`(${ref.validFrom} > ${asOf})`;

/** Whether the version's window is still open on `asOf`. */
const stillOpenOn = (ref: LegislationVersionRef, asOf: SQLWrapper): SQL =>
  sql`(${ref.validTo} IS NULL OR ${ref.validTo} > ${asOf})`;

/**
 * An eligible version whose window covers the given date. The window is the
 * corpus half-open interval `[version_valid_from, version_valid_to)`, so a
 * version whose successor opens on that date has already ended on it. A null
 * `version_valid_from` on an eligible version marks a work kept as a single
 * unversioned text, which covers every date.
 *
 * Every read that answers "which text applied then" builds on this one
 * predicate: the listing (at `CURRENT_DATE`) and the point-in-time read (at a
 * caller-supplied date) must not be able to disagree about a boundary, nor
 * about which versions may answer.
 */
export const inForceOn = (ref: LegislationVersionRef, asOf: SQLWrapper): SQL =>
  sql`(${eligibleExpression(ref)} AND ${openedBy(ref, asOf)} AND ${stillOpenOn(ref, asOf)})`;

/** `inForceOn` evaluated at the database's current date. */
export const inForceToday = (ref: LegislationVersionRef): SQL =>
  inForceOn(ref, sql`CURRENT_DATE`);

/** A version reference plus the Work key and id it is ordered by. */
export type LegislationVersionRow = LegislationVersionRef & {
  id: SQLWrapper;
  sourceId: SQLWrapper;
  eli: SQLWrapper;
  language: SQLWrapper;
};

/** The row for `legislation_documents` or a Drizzle alias of it. */
export const legislationVersionRow = (
  table: LegislationVersionColumns & {
    id: SQLWrapper;
    sourceId: SQLWrapper;
    eli: SQLWrapper;
    language: SQLWrapper;
  },
): LegislationVersionRow => ({
  ...legislationVersionRef(table),
  id: table.id,
  sourceId: table.sourceId,
  eli: table.eli,
  language: table.language,
});

const INVALID_WINDOW_SQL = sql.raw(`'invalid-window'`);

/**
 * Whether this version is why a point-in-time read at `asOf` has no answer:
 * its publisher window is inconsistent, and it is the latest version of its
 * own `(source, eli, language)` that opened by then.
 *
 * Only versions of an applicable kind count on either side, so a promulgated
 * text opening the same day cannot hide the gap, and neither can a version in
 * another language. Withdrawn tombstones count on neither side.
 *
 * A version with no stated start (`missing-start`) cannot be placed in time.
 * It sorts below every dated version, as the listing orders it, so it names
 * the gap for exactly the dates by which no dated version of its language
 * had opened: for a Work holding only such versions, every date.
 *
 * Callers evaluate it only once no eligible version answers the date: it
 * explains an empty answer and must never replace a real one. It reads the
 * stored window and disposition only; nothing display-only feeds it.
 */
export const isInconsistentWindowGapAt = (
  row: LegislationVersionRow,
  asOf: SQLWrapper,
): SQL => {
  const later = legislationVersionRefAt("gap_later");
  return sql`(
  ${row.disposition} = ${INVALID_WINDOW_SQL}
  AND ${applicableKind(row)}
  AND ${openedBy(row, asOf)}
  AND NOT EXISTS (
    SELECT 1
      FROM legislation_documents AS gap_later
     WHERE gap_later.source_id = ${row.sourceId}
       AND gap_later.eli = ${row.eli}
       AND gap_later.language = ${row.language}
       AND gap_later.id <> ${row.id}
       AND ${applicableKind(later)}
       AND ${notWithdrawn(later)}
       AND ${openedBy(later, asOf)}
       AND (${versionSortKey(later.validFrom)}, gap_later.id)
         > (${versionSortKey(row.validFrom)}, ${row.id})
  )
)`;
};
