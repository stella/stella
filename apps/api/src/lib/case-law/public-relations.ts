/**
 * What a public case-law read may touch, and therefore the exact SELECT
 * grant set of `stella_caselaw_reader` (20260821150000_case_law_reader_role).
 *
 * Free of side effects on purpose: the connection validator, the schema's
 * reader policies and the test database builder all derive from these
 * lists, and the last of those must not pull in a database client.
 */

/** Relations readable whole. `case_law_sources` is not among them. */
export const PUBLIC_CASE_LAW_TABLES = [
  "case_law_citations",
  "case_law_corpus_index_projections",
  "case_law_decisions",
  "case_law_provision_citations",
] as const;

/** The one relation read column by column. */
export const PUBLIC_CASE_LAW_SOURCE_TABLE = "case_law_sources";

/**
 * The columns of `case_law_sources` a public read uses: the join key, the
 * two display fields and the redistribution descriptor. The rest of the row
 * (sync cursors, lease tokens, adapter config) is operational and stays out
 * of reach.
 */
export const PUBLIC_CASE_LAW_SOURCE_COLUMNS = [
  "id",
  "name",
  "adapter_key",
  "descriptor",
] as const;

/** Every relation a public read may name, whole or in part. */
export const PUBLIC_CASE_LAW_RELATIONS = [
  ...PUBLIC_CASE_LAW_TABLES,
  PUBLIC_CASE_LAW_SOURCE_TABLE,
] as const;
