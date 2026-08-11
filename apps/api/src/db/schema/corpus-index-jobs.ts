/**
 * Vocabulary shared by the case-law and legislation index-job tables. Both
 * record the same append-only audit of search-index mutations, so the
 * operation and status sets are declared once here and feed both column types
 * and both check constraints.
 */

import { sql } from "drizzle-orm";

/** What an index-job row records having done to the corpus. */
export const CORPUS_INDEX_JOB_OPERATIONS = [
  "index",
  "delete",
  "redact",
  "rebuild",
] as const;

export type CorpusIndexJobOperation =
  (typeof CORPUS_INDEX_JOB_OPERATIONS)[number];

/** Terminal outcome of the recorded operation; jobs are logged after the fact. */
export const CORPUS_INDEX_JOB_STATUSES = ["succeeded", "failed"] as const;

export type CorpusIndexJobStatus = (typeof CORPUS_INDEX_JOB_STATUSES)[number];

export const CORPUS_INDEX_JOB_OPERATION_SQL_VALUES =
  CORPUS_INDEX_JOB_OPERATIONS.map((operation) => sql.raw(`'${operation}'`));

export const CORPUS_INDEX_JOB_STATUS_SQL_VALUES = CORPUS_INDEX_JOB_STATUSES.map(
  (status) => sql.raw(`'${status}'`),
);
