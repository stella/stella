import { expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { caseLawCitations } from "@/api/db/schema";
import {
  citationReopenableByKeySql,
  unsettledCitationSql,
} from "@/api/handlers/case-law/citation-resolution-status";

/**
 * The walk's WHERE clause, the burn-down index in the schema, and the DDL that
 * builds that index in production must be the same predicate.
 *
 * A partial index whose predicate is narrower than the query it serves is not a
 * slower index, it is an unused one: Postgres silently falls back to a scan of
 * four million rows, every statement still returns the right answer, and
 * nothing about the query looks wrong. The schema and the query already derive
 * from one exported fragment; the migration is hand-written SQL that cannot,
 * so it is pinned here instead.
 */

const MIGRATION = nodePath.resolve(
  import.meta.dir,
  "../../../drizzle/20260816122000_citation_resolution_indexes/migration.sql",
);

const WALK_INDEX = "case_law_citations_pending_walk_idx";
const REOPEN_INDEX = "case_law_citations_reopenable_key_idx";

/**
 * Compare SQL as SQL, not as text. Whitespace runs collapse, and whitespace
 * next to a parenthesis or a comma disappears entirely, because the renderer
 * pads them and hand-written DDL does not. Everything else — operators, the
 * order of the arms, the quoted identifiers — has to match exactly, which is
 * the whole point.
 */
const normalize = (statement: string): string =>
  statement
    .replaceAll(/\s+/gu, " ")
    .replaceAll(/\s*([(),])\s*/gu, "$1")
    .trim();

const render = (fragment: SQL): string =>
  normalize(new PgDialect().sqlToQuery(fragment).sql);

/** The DDL statement that builds one index, as the migration spells it. */
const migrationDdl = (index: string): string | undefined =>
  readFileSync(MIGRATION, "utf-8")
    .split(";")
    .map(normalize)
    .find((statement) =>
      statement.includes(`CREATE INDEX CONCURRENTLY "${index}"`),
    );

/** The predicate a partial index in the schema was declared with. */
const schemaPredicate = (index: string): string | undefined => {
  const where = getTableConfig(caseLawCitations).indexes.find(
    (candidate) => candidate.config.name === index,
  )?.config.where;
  return where === undefined ? undefined : render(where);
};

/**
 * Each partial index, the fragment it must be built from as the migration
 * spells it (quoted, unqualified columns), and the same fragment against the
 * table's own columns. The second form also proves the fragment is being handed
 * the right columns rather than merely being called.
 */
const PARTIAL_INDEXES = [
  {
    index: WALK_INDEX,
    migration: () =>
      render(
        unsettledCitationSql({
          resolutionStatus: sql.raw('"resolution_status"'),
          citedDecisionId: sql.raw('"cited_decision_id"'),
          citationKey: sql.raw('"citation_key"'),
        }),
      ),
    schema: () =>
      render(
        unsettledCitationSql({
          resolutionStatus: caseLawCitations.resolutionStatus,
          citedDecisionId: caseLawCitations.citedDecisionId,
          citationKey: caseLawCitations.citationKey,
        }),
      ),
  },
  {
    index: REOPEN_INDEX,
    migration: () =>
      render(citationReopenableByKeySql(sql.raw('"resolution_status"'))),
    schema: () =>
      render(citationReopenableByKeySql(caseLawCitations.resolutionStatus)),
  },
] as const;

test("every migration index is built over the predicate its queries use", () => {
  for (const { index, migration } of PARTIAL_INDEXES) {
    const ddl = migrationDdl(index);
    expect(ddl).toBeDefined();
    expect(ddl).toContain(migration());
  }
});

test("every schema index declares the same predicate as the migration", () => {
  for (const { index, schema } of PARTIAL_INDEXES) {
    expect(schemaPredicate(index)).toBe(schema());
  }
});
