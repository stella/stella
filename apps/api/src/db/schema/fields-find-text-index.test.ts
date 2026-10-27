import { expect, test } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { fields } from "@/api/db/schema";
import { FINDABLE_FIELD_TYPES } from "@/api/lib/entity-filters";

const INDEX_NAME = "fields_find_text_trgm_idx";

const migration = readFileSync(
  nodePath.resolve(
    import.meta.dir,
    "../../../drizzle/20260907173500_field_find_text_trgm/migration.sql",
  ),
  "utf-8",
);

/** The single-quoted literals in a SQL fragment, in order. */
const quotedLiterals = (fragment: string): string[] =>
  [...fragment.matchAll(/'([^']+)'/gu)].map((match) => match[1] ?? "");

const statementContaining = (fragment: string): string => {
  const statement = migration
    .split("--> statement-breakpoint")
    .find((part) => part.includes(fragment));
  if (statement === undefined) {
    throw new Error(`migration has no statement containing ${fragment}`);
  }
  return statement;
};

const findIndex = getTableConfig(fields).indexes.find(
  ({ config }) => config.name === INDEX_NAME,
);
if (findIndex === undefined) {
  throw new Error(`fields declares no ${INDEX_NAME}`);
}

// Three places name the findable cell types by hand: the Drizzle predicate,
// the migration's predicate, and the function's branches. A type added to
// `FIELD_FIND_SUPPORT` as searchable would otherwise be matched by the query
// and missing from the index, which is the unindexed scan coming back one
// column at a time.
test("the index predicate names exactly the findable cell types", () => {
  const { where } = findIndex.config;
  if (where === undefined) {
    throw new Error(`${INDEX_NAME} is not partial`);
  }
  const predicate = new PgDialect().sqlToQuery(where).sql;

  expect(quotedLiterals(predicate)).toEqual(["type", ...FINDABLE_FIELD_TYPES]);
});

test("the migration builds the same index over the same function", () => {
  const create = statementContaining(
    `CREATE INDEX CONCURRENTLY "${INDEX_NAME}"`,
  );
  const predicate = create.slice(create.indexOf("WHERE"));

  expect(create).toContain(
    'USING gin (field_find_text("content") gin_trgm_ops)',
  );
  expect(quotedLiterals(predicate)).toEqual(["type", ...FINDABLE_FIELD_TYPES]);
  expect(migration).toContain(
    `DROP INDEX CONCURRENTLY IF EXISTS "${INDEX_NAME}"`,
  );
});

test("the function has one branch per findable cell type and no other", () => {
  const body = statementContaining(
    "CREATE OR REPLACE FUNCTION field_find_text",
  );
  const branches = [...body.matchAll(/WHEN '([^']+)' THEN/gu)].map(
    (match) => match[1],
  );

  expect(new Set(branches)).toEqual(new Set(FINDABLE_FIELD_TYPES));
});
