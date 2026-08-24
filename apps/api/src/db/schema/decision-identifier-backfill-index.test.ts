import { expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { caseLawCitations } from "@/api/db/schema";
import {
  effectiveCitationIdentifierTypeSql,
  effectiveCitationIdentifierValueSql,
  settledCitationSql,
} from "@/api/handlers/case-law/citation-resolution-status";

const INDEX_NAME = "case_law_citations_identifier_backfill_identity_idx";
const MIGRATION = nodePath.resolve(
  import.meta.dir,
  "../../../drizzle/20260825110000_decision_identifier_backfill_checkpoint/migration.sql",
);

const normalize = (statement: string): string =>
  statement
    .replaceAll(/\s+/gu, " ")
    .replaceAll(/\s*([(),])\s*/gu, "$1")
    .trim();

const render = (fragment: SQL): string =>
  normalize(new PgDialect().sqlToQuery(fragment).sql);

test("the backfill citation identity index matches its query contract", () => {
  const ddl = readFileSync(MIGRATION, "utf-8")
    .split(";")
    .map(normalize)
    .find((statement) =>
      statement.includes(`CREATE INDEX CONCURRENTLY "${INDEX_NAME}"`),
    );
  expect(ddl).toBeDefined();
  expect(ddl).toContain(
    render(effectiveCitationIdentifierTypeSql(sql.raw('"identifier_type"'))),
  );
  expect(ddl).toContain(
    render(
      effectiveCitationIdentifierValueSql(
        sql.raw('"normalized_identifier_value"'),
        sql.raw('"citation_key"'),
      ),
    ),
  );
  expect(ddl).toContain(
    render(settledCitationSql(sql.raw('"resolution_status"'))),
  );

  const index = getTableConfig(caseLawCitations).indexes.find(
    (candidate) => candidate.config.name === INDEX_NAME,
  );
  expect(index?.config.columns).toHaveLength(2);
  expect(index?.config.where).toBeDefined();
});
