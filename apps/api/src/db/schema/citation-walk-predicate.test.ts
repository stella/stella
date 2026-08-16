import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { caseLawCitations } from "@/api/db/schema";
import { unsettledCitationSql } from "@/api/handlers/case-law/citation-resolution-status";

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

/** The predicate as the migration spells it: quoted, unqualified columns. */
const renderedPredicate = (): string =>
  normalize(
    new PgDialect().sqlToQuery(
      unsettledCitationSql({
        resolutionStatus: sql.raw('"resolution_status"'),
        citedDecisionId: sql.raw('"cited_decision_id"'),
        citationKey: sql.raw('"citation_key"'),
      }),
    ).sql,
  );

test("the migration builds the index over the predicate the walk queries", () => {
  const ddl = readFileSync(MIGRATION, "utf-8")
    .split(";")
    .map(normalize)
    .find((statement) =>
      statement.includes(`CREATE INDEX CONCURRENTLY "${WALK_INDEX}"`),
    );
  expect(ddl).toBeDefined();
  expect(ddl).toContain(renderedPredicate());
});

test("the schema declares the same predicate as the migration", () => {
  const walkIndex = getTableConfig(caseLawCitations).indexes.find(
    (index) => index.config.name === WALK_INDEX,
  );
  expect(walkIndex).toBeDefined();
  const where = walkIndex?.config.where;
  expect(where).toBeDefined();
  // Rendered against the table's own columns, so this also proves the fragment
  // is being given the right three columns rather than merely being called.
  expect(
    where === undefined
      ? undefined
      : normalize(new PgDialect().sqlToQuery(where).sql),
  ).toBe(
    normalize(
      new PgDialect().sqlToQuery(
        unsettledCitationSql({
          resolutionStatus: caseLawCitations.resolutionStatus,
          citedDecisionId: caseLawCitations.citedDecisionId,
          citationKey: caseLawCitations.citationKey,
        }),
      ).sql,
    ),
  );
});
