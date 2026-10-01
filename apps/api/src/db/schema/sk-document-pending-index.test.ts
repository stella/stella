import { expect, test } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import { caseLawDecisions } from "@/api/db/schema";
import { DOCUMENT_OUTSTANDING_INDEX } from "@/api/lib/legal-search/sk-document-outstanding-index";
import { pendingDeferredDocumentSql } from "@/api/lib/legal-search/sk-document-pending-sql";

const OUTSTANDING_INDEX = "case_law_decisions_document_outstanding_idx";

test("the outstanding-document index uses the queue's exact pending predicate", () => {
  const index = getTableConfig(caseLawDecisions).indexes.find(
    ({ config }) => config.name === OUTSTANDING_INDEX,
  );
  const indexPredicate = index?.config.where;

  expect(indexPredicate).toBeDefined();
  expect(indexPredicate && new PgDialect().sqlToQuery(indexPredicate).sql).toBe(
    new PgDialect().sqlToQuery(pendingDeferredDocumentSql(caseLawDecisions))
      .sql,
  );
});

test("online repair creates the index with the shared outstanding predicate", () => {
  const expected = new PgDialect()
    .sqlToQuery(pendingDeferredDocumentSql(caseLawDecisions))
    .sql.replaceAll('"case_law_decisions".', "");
  expect(DOCUMENT_OUTSTANDING_INDEX.createSql).toBe(
    `CREATE INDEX CONCURRENTLY "case_law_decisions_document_outstanding_idx" ON public."case_law_decisions" USING btree ("source_id", "id") WHERE ${expected}`,
  );
});
