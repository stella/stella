import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { RequiredMigrationIndex } from "@/api/lib/db/migration-history";
import { EMPTY_CORPUS_CONTENT_HASHES } from "@/api/lib/legal-search/corpus-content-hash";
import { pendingDeferredDocumentSql } from "@/api/lib/legal-search/sk-document-pending-sql";

const EMPTY_CORPUS_HASHES_TEXT_ARRAY = `ARRAY[${EMPTY_CORPUS_CONTENT_HASHES.map((hash) => `'${hash}'::text`).join(", ")}]`;
const DOCUMENT_OUTSTANDING_PREDICATE_SQL = new PgDialect().sqlToQuery(
  pendingDeferredDocumentSql({
    redactedAt: sql.identifier("redacted_at"),
    fulltext: sql.identifier("fulltext"),
    documentUrl: sql.identifier("document_url"),
    contentHash: sql.identifier("content_hash"),
    documentAst: sql.identifier("document_ast"),
  }),
).sql;
const DOCUMENT_OUTSTANDING_DEFINITION_BODY = `ON public.case_law_decisions USING btree (source_id, id) WHERE ((redacted_at IS NULL) AND (fulltext IS NULL) AND (document_url IS NOT NULL) AND ((content_hash IS NULL) OR ((content_hash)::text = ANY (${EMPTY_CORPUS_HASHES_TEXT_ARRAY})) OR (document_ast IS NOT NULL)))`;

export const DOCUMENT_OUTSTANDING_INDEX = {
  createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_document_outstanding_idx" ON public."case_law_decisions" USING btree ("source_id", "id") WHERE ${DOCUMENT_OUTSTANDING_PREDICATE_SQL}`,
  definitionBody: DOCUMENT_OUTSTANDING_DEFINITION_BODY,
  isUnique: false,
  name: "case_law_decisions_document_outstanding_idx",
  tableName: "case_law_decisions",
} as const satisfies RequiredMigrationIndex & { createSql: string };
