/**
 * Tables whose row count scales with the legal corpus rather than with
 * workspaces: millions of rows in production, a handful in every test and
 * smoke database.
 *
 * A migration statement that rewrites one of them runs inside the deployment
 * transaction under the migration's statement budget, and a WHERE clause is no
 * evidence that it finishes: a predicate the table cannot serve from an index
 * scans the table however few rows it matches, and no empty-database rehearsal
 * can tell the two apart. `scripts/check-migration-safety.ts` therefore refuses
 * UPDATE, DELETE, INSERT ... SELECT and MERGE against these names in a schema
 * migration, with no acknowledgement. A data repair on one of them is a
 * registered online repair (`online-migrations.ts`): bounded batches over an
 * indexed access path, resumable, validated on completion.
 *
 * No imports, so the checker can load this file from `scripts/` without the
 * API's path aliases; `high-volume-tables.test.ts` proves every name is a table
 * the schema declares.
 */
export const HIGH_VOLUME_TABLES = [
  "case_law_citations",
  "case_law_decision_identifiers",
  "case_law_decisions",
  // One append-only audit row per document per index operation, so the trail
  // grows with the corpus and with every rebuild of it.
  "case_law_index_jobs",
  "case_law_provision_citations",
  "case_law_search_document_preview_passages",
  "case_law_search_documents",
  "corpus_index_projection_intents",
  "corpus_index_projection_states",
  "legislation_index_jobs",
] as const;
