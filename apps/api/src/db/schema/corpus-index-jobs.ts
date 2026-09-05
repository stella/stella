/**
 * Vocabulary shared by the case-law and legislation index-job tables. Both
 * record the same append-only audit of search-index mutations, so the
 * operation and status sets are declared once here and feed both column types
 * and both check constraints.
 */

import { sql } from "drizzle-orm";

/**
 * What an index-job row records having done to the corpus.
 *
 * `redact` and `withdraw` both leave a document row holding no text, and
 * they are separate words because they mean opposite things about that
 * row. A redaction is a takedown: the row is tombstoned and nothing may
 * put text back on it, which is why a partial index over this column
 * reads `redact` rows as tombstones. A withdrawal says the stored text
 * was never the publisher's document; the row keeps its identity and its
 * stored payload, and a later parser may replay it into a document.
 */
export const CORPUS_INDEX_JOB_OPERATIONS = [
  "index",
  "delete",
  "redact",
  "rebuild",
  "withdraw",
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

/**
 * The status of a row whose operation went through. Such a row carries its
 * reason in `detail`; `error_message` is the failure of the row it sits on,
 * and both tables constrain the pair from this one declaration.
 */
const CORPUS_INDEX_JOB_SUCCEEDED_STATUS =
  "succeeded" as const satisfies CorpusIndexJobStatus;

export const CORPUS_INDEX_JOB_SUCCEEDED_SQL_VALUE = sql.raw(
  `'${CORPUS_INDEX_JOB_SUCCEEDED_STATUS}'`,
);
