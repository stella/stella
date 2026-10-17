#!/usr/bin/env bun
// Schema parity: the database DATABASE_URL names must match schema.ts. Runs
// `drizzle-kit push --explain` from apps/api and accepts exactly one kind of
// difference: dropping what a `stella:retired` comment marks (the table or
// column, and the policies, constraints and indexes that go with it), because
// the expand half of a split removal keeps it in the database for the release
// before. A marked object schema.ts still declares is an error: the marker
// would exempt a used object from the rollback checks.
//
//   DATABASE_URL=<migrated database> bun scripts/check-migrated-schema-parity.ts

import { panic } from "better-result";
import { SQL } from "bun";
import path from "node:path";

import { isRetiredSchemaComment } from "./migration-retired-schema";

const API_DIR = path.join(import.meta.dir, "../apps/api");
const NO_CHANGES = "No changes detected";
const STATEMENTS_HEADER = "--- Generated migration statements ---";

type Commented = { name: string; comment: string | null };
type CommentedColumn = Commented & { table: string };
type Dependent = { table: string; name: string };

export type RetiredSchema = {
  tables: readonly string[];
  /** Columns of tables that are not themselves retired. */
  columns: readonly { table: string; column: string }[];
  policies: readonly Dependent[];
  constraints: readonly Dependent[];
  indexes: readonly string[];
};

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** The drop statements drizzle-kit proposes for the retired objects. */
const expectedRetirementStatements = (retired: RetiredSchema) => ({
  primary: [
    ...retired.tables.map((table) => `DROP TABLE ${quote(table)};`),
    ...retired.columns.map(
      ({ table, column }) =>
        `ALTER TABLE ${quote(table)} DROP COLUMN ${quote(column)};`,
    ),
  ],
  dependent: [
    ...retired.policies.map(
      ({ table, name }) => `DROP POLICY ${quote(name)} ON ${quote(table)};`,
    ),
    ...retired.constraints.map(
      ({ table, name }) =>
        `ALTER TABLE ${quote(table)} DROP CONSTRAINT ${quote(name)};`,
    ),
    ...retired.indexes.map((name) => `DROP INDEX ${quote(name)};`),
  ],
});

/** The statements a `push --explain` run proposes; null when it found none. */
export const proposedStatements = (output: string): string[] | null => {
  if (output.includes(NO_CHANGES)) {
    return null;
  }
  const header = output.indexOf(STATEMENTS_HEADER);
  if (header === -1) {
    return [];
  }
  return output
    .slice(header + STATEMENTS_HEADER.length)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

type ParityVerdict =
  | { type: "match" }
  | { type: "unparsed" }
  | {
      type: "mismatch";
      /** Differences no retirement explains. */
      unexplained: string[];
      /** Retired objects schema.ts still declares. */
      stillDeclared: string[];
    };

export const judgeParity = (
  proposed: readonly string[] | null,
  retired: RetiredSchema,
): ParityVerdict => {
  const { primary, dependent } = expectedRetirementStatements(retired);
  if (proposed !== null && proposed.length === 0) {
    return { type: "unparsed" };
  }
  const statements = new Set(proposed);
  const allowed = new Set([...primary, ...dependent]);
  const unexplained = [...statements].filter(
    (statement) => !allowed.has(statement),
  );
  const stillDeclared = primary.filter(
    (statement) => !statements.has(statement),
  );
  return unexplained.length === 0 && stillDeclared.length === 0
    ? { type: "match" }
    : { type: "mismatch", unexplained, stillDeclared };
};

const readRetiredSchema = async (client: SQL): Promise<RetiredSchema> => {
  const tables: Commented[] = await client.unsafe(`
    SELECT c.relname AS name, obj_description(c.oid, 'pg_class') AS comment
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind IN ('r', 'p')
      AND obj_description(c.oid, 'pg_class') IS NOT NULL`);
  const columns: CommentedColumn[] = await client.unsafe(`
    SELECT c.relname AS "table", a.attname AS name,
           col_description(c.oid, a.attnum) AS comment
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
      AND a.attnum > 0 AND NOT a.attisdropped
      AND col_description(c.oid, a.attnum) IS NOT NULL`);
  const retiredTables = tables
    .filter(({ comment }) => isRetiredSchemaComment(comment))
    .map(({ name }) => name);
  const retiredColumns = columns
    .filter(
      ({ table, comment }) =>
        isRetiredSchemaComment(comment) && !retiredTables.includes(table),
    )
    .map(({ table, name }) => ({ table, column: name }));
  if (retiredTables.length === 0 && retiredColumns.length === 0) {
    return {
      tables: [],
      columns: [],
      policies: [],
      constraints: [],
      indexes: [],
    };
  }
  const tablesParameter = JSON.stringify(retiredTables);
  const columnsParameter = JSON.stringify(retiredColumns);
  const retiredColumnsCte = (parameter: string) => `retired_columns AS (
       SELECT a.attrelid, a.attnum
       FROM jsonb_to_recordset(${parameter}::text::jsonb) AS r("table" text, "column" text)
       JOIN pg_class c ON c.relname = r."table"
         AND c.relnamespace = 'public'::regnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = r."column"
     )`;
  const retiredTableNames =
    "ARRAY(SELECT jsonb_array_elements_text($1::text::jsonb))";
  const policies: Dependent[] = await client.unsafe(
    `SELECT c.relname AS "table", p.polname AS name
     FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relname = ANY (${retiredTableNames})`,
    [tablesParameter],
  );
  // Constraints on a retired column, and foreign keys from other tables into
  // a retired table or column; a retired table's own constraints go with it.
  const constraints: Dependent[] = await client.unsafe(
    `WITH ${retiredColumnsCte("$2")}
     SELECT DISTINCT c.relname AS "table", con.conname AS name
     FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     LEFT JOIN pg_class referenced ON referenced.oid = con.confrelid
     WHERE c.relnamespace = 'public'::regnamespace
       AND NOT (c.relname = ANY (${retiredTableNames}))
       AND (
         EXISTS (SELECT 1 FROM retired_columns r
                 WHERE (r.attrelid = con.conrelid AND r.attnum = ANY (con.conkey))
                    OR (r.attrelid = con.confrelid AND r.attnum = ANY (con.confkey)))
         OR referenced.relname = ANY (${retiredTableNames})
       )`,
    [tablesParameter, columnsParameter],
  );
  const indexes: { name: string }[] = await client.unsafe(
    `WITH ${retiredColumnsCte("$1")}
     SELECT DISTINCT i.relname AS name
     FROM pg_depend d JOIN pg_class i ON i.oid = d.objid
     JOIN retired_columns r ON r.attrelid = d.refobjid AND r.attnum = d.refobjsubid
     WHERE d.classid = 'pg_class'::regclass AND i.relkind = 'i'
       AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.oid
                       AND con.conrelid = r.attrelid)`,
    [columnsParameter],
  );
  return {
    tables: retiredTables,
    columns: retiredColumns,
    policies,
    constraints,
    indexes: indexes.map(({ name }) => name),
  };
};

const runPushExplain = (): string => {
  const result = Bun.spawnSync(
    ["bun", "--bun", "drizzle-kit", "push", "--explain"],
    { cwd: API_DIR, stdout: "pipe", stderr: "pipe" },
  );
  return `${result.stdout.toString()}${result.stderr.toString()}`;
};

const main = async () => {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const client = new SQL({ url, max: 1, connectionTimeout: 30 });
  const retired = await readRetiredSchema(client).finally(
    async () => await client.end(),
  );
  const output = runPushExplain();
  const verdict = judgeParity(proposedStatements(output), retired);
  switch (verdict.type) {
    case "match": {
      const count = retired.tables.length + retired.columns.length;
      console.log(
        count === 0
          ? "Schema matches schema.ts."
          : `Schema matches schema.ts apart from ${String(count)} retired table(s) and column(s) kept for the previous release.`,
      );
      return;
    }
    case "unparsed": {
      console.error(output);
      console.error(
        "::error::drizzle-kit push --explain reported neither a match nor a list of statements.",
      );
      process.exitCode = 1;
      return;
    }
    case "mismatch": {
      console.error(output);
      for (const statement of verdict.unexplained) {
        console.error(`  not explained by a retirement: ${statement}`);
      }
      for (const statement of verdict.stillDeclared) {
        console.error(
          `  marked stella:retired but schema.ts still declares it (expected ${statement})`,
        );
      }
      console.error(
        "::error::Migrated schema does not match schema.ts. Commit a migration that closes the gap or fix the migration files; to keep a table or column only for the previous release, stop declaring it in schema.ts and mark it stella:retired.",
      );
      process.exitCode = 1;
      return;
    }
    default: {
      verdict satisfies never;
      panic(`unhandled parity verdict: ${JSON.stringify(verdict)}`);
    }
  }
};

if (import.meta.main) {
  await main();
}
