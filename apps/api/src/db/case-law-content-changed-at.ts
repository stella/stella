/**
 * `case_law_decisions.content_changed_at`, introduced by migration
 * 20261117160000_case_law_content_changed_at: when the decision's content
 * last changed, so a consumer can read only the rows whose content changed
 * since it last looked, instead of every row of a source.
 *
 * `updated_at` cannot answer that: it is stamped by the query builder, and a
 * raw SQL write leaves it alone. This column is stamped by a trigger on every
 * write path, and only when a content column's value actually changed.
 *
 * A consumer that measures a decision reads only the columns listed here,
 * plus the identity (`id`, `created_at`) and this column. A column added to
 * the list without the trigger, or to the trigger without the list, fails
 * `case-law-content-changed-at.postgres.test.ts`.
 */

/** How the trigger compares a content column's old and new value. */
export const CONTENT_COMPARISON = {
  /** The value itself. */
  value: "value",
  /** The stored size in bytes, read from the value's header. */
  storedSize: "storedSize",
} as const;

export type ContentComparison =
  (typeof CONTENT_COMPARISON)[keyof typeof CONTENT_COMPARISON];

/**
 * The content columns of a decision, by PostgreSQL name. The Postgres test
 * writes each one, so a name that is not a column fails it.
 */
export type CaseLawContentColumn =
  | "source_id"
  | "redacted_at"
  | "country"
  | "case_number"
  | "court"
  | "decision_type"
  | "ecli"
  | "fulltext"
  | "metadata";

/**
 * The content columns of a decision, by PostgreSQL name, and how a change to
 * each is detected. Full text counts by its stored size: a reader measures its
 * size, never its text, and comparing sizes keeps an update from detoasting
 * the old text.
 */
export const CASE_LAW_CONTENT_COLUMNS = {
  source_id: CONTENT_COMPARISON.value,
  redacted_at: CONTENT_COMPARISON.value,
  country: CONTENT_COMPARISON.value,
  case_number: CONTENT_COMPARISON.value,
  court: CONTENT_COMPARISON.value,
  decision_type: CONTENT_COMPARISON.value,
  ecli: CONTENT_COMPARISON.value,
  fulltext: CONTENT_COMPARISON.storedSize,
  metadata: CONTENT_COMPARISON.value,
} as const satisfies Record<CaseLawContentColumn, ContentComparison>;

export const CASE_LAW_CONTENT_CHANGE_TRIGGER =
  "case_law_decisions_zy_content_changed_at";

export const CASE_LAW_CONTENT_CHANGE_FUNCTION = "stamp_case_law_content_change";
