import type { SQL, SQLWrapper } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { EMPTY_CORPUS_CONTENT_HASHES } from "@/api/lib/legal-search/corpus-content-hash";

type PendingDocumentColumns = {
  redactedAt: SQLWrapper;
  fulltext: SQLWrapper;
  documentUrl: SQLWrapper;
  contentHash: SQLWrapper;
  documentAst: SQLWrapper;
};

const EMPTY_HASH_LIST = sql.join(
  // These hashes are produced by corpus-content-hash; literals keep the
  // query predicate provable against the partial index under generic plans.
  EMPTY_CORPUS_CONTENT_HASHES.map((hash) => sql.raw(`'${hash}'::text`)),
  sql`, `,
);

/** Whether the Postgres columns and corpus key together hold no document. */
export const storesNoCorpusDocumentSql = ({
  contentHash,
  documentAst,
}: PendingDocumentColumns): SQL =>
  sql`(${contentHash} IS NULL OR ${contentHash} IN (${EMPTY_HASH_LIST}) OR ${documentAst} IS NOT NULL)`;

/** The shared exact predicate for every decision awaiting a PDF. */
export const pendingDeferredDocumentSql = (
  columns: PendingDocumentColumns,
): SQL =>
  sql`(${columns.redactedAt} IS NULL AND ${columns.fulltext} IS NULL AND ${columns.documentUrl} IS NOT NULL AND ${storesNoCorpusDocumentSql(columns)})`;
