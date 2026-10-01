import { expect, test } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import { caseLawDecisions } from "@/api/db/schema";
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

// The committed DDL must stay aligned with the predicate used by Drizzle.
test("the concurrent migration preserves the shared outstanding predicate", async () => {
  const migration = await Bun.file(
    new URL(
      "../../../drizzle/20261003123100_case_law_document_outstanding_idx/migration.sql",
      import.meta.url,
    ),
  ).text();
  const predicate = migration.match(/WHERE ([\s\S]*?);/u)?.at(1);
  expect(predicate).toBeDefined();
  const expected = new PgDialect()
    .sqlToQuery(pendingDeferredDocumentSql(caseLawDecisions))
    .sql.replaceAll('"case_law_decisions".', "");
  const normalized = (value: string) => value.replace(/\s+/gu, " ").trim();
  expect(predicate && normalized(`(${predicate})`)).toBe(normalized(expected));
});
