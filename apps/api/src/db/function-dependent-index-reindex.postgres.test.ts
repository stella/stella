import { panic, Result } from "better-result";
import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  migrationStatementTokens,
  parseMigrationStatements,
  readMigrationRelation,
} from "../../../../scripts/check-migration-safety";
import { CASE_LAW_FILING_YEAR_FUNCTION_SIGNATURE } from "../lib/case-law/coverage-index";
import { getPgErrorCode } from "../lib/pg-error";
import { isRecord } from "../lib/type-guards";
import { withGatedTestClients } from "../tests/gated-test-database";
import { withIsolatedPostgresCluster } from "../tests/isolated-postgres-cluster";
import {
  createFunctionDependentIndexReindex,
  FUNCTION_DEPENDENT_INDEX_REINDEXES,
  readFunctionDependentIndexes,
} from "./function-dependent-index-reindex";
import { createUngatedTableGateForTests } from "./online-ddl";
import type { OnlineTableGate } from "./online-ddl";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import { ONLINE_MIGRATION_REPAIRS } from "./online-migrations";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const revision = "20261030000000_function_reindex_fixture";
const signature = "public.function_reindex_fixture(integer)";
const definition = `CREATE OR REPLACE FUNCTION public.function_reindex_fixture(value integer)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT value + 1 $$;`;

const connectionOf = (database: SQL): OnlineMigrationConnection => ({
  execute: async (statement, parameters = []) => {
    await database.unsafe(statement, [...parameters]);
  },
  query: async (statement, parameters = []) =>
    await database.unsafe<unknown[]>(statement, [...parameters]),
  release: () => undefined,
});

type ReplacementCoverageOptions = {
  connection: OnlineMigrationConnection;
  migrations: readonly { revision: string; sql: string }[];
  repairs: typeof FUNCTION_DEPENDENT_INDEX_REINDEXES;
};

type ReplacementArgumentOptions = {
  connection: OnlineMigrationConnection;
  statement: ReturnType<typeof parseMigrationStatements>[number];
  tokens: ReturnType<typeof migrationStatementTokens>;
  start: number;
};

/** PostgreSQL resolves aliases, qualified types, arrays and typmods; the scanner owns boundaries. */
const replacementArgumentTypes = async ({
  connection,
  statement,
  tokens,
  start,
}: ReplacementArgumentOptions) => {
  if (tokens.at(start)?.value !== "(") {
    return panic("Replacement function arguments are missing");
  }
  const offset = tokens.at(0)?.index ?? 0;
  const groups: (typeof tokens)[] = [];
  let depth = 0;
  let beginning = start + 1;
  for (let index = beginning; index < tokens.length; index += 1) {
    const token = tokens.at(index);
    if (token?.value === "(") {
      depth += 1;
    }
    if (token?.value === ")" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth === 0 && (token?.value === "," || token?.value === ")")) {
      groups.push(tokens.slice(beginning, index + 1));
      beginning = index + 1;
      if (token.value === ")") {
        break;
      }
    }
  }
  const oids: string[] = [];
  for (const group of groups) {
    const mode = group.at(0);
    if (group.length === 1 || (mode?.kind === "word" && mode.value === "out")) {
      continue;
    }
    let first = 0;
    if (
      mode?.kind === "word" &&
      ["in", "inout", "variadic"].includes(mode.value)
    ) {
      first += 1;
    }
    const end =
      group.find((token) => token.kind === "word" && token.value === "default")
        ?.index ??
      group.at(-1)?.index ??
      panic("Replacement argument has no boundary");
    let oid: string | undefined;
    for (const candidateStart of [
      group.at(first)?.index,
      group.at(first + 1)?.index,
    ]) {
      if (candidateStart === undefined || candidateStart >= end) {
        continue;
      }
      const masked = statement.text.slice(candidateStart, end);
      const equals = masked.indexOf("=");
      const source = statement.raw
        .slice(
          candidateStart - offset,
          (equals === -1 ? end : candidateStart + equals) - offset,
        )
        .trim();
      const result = await Result.tryPromise({
        try: async () =>
          await connection.query("SELECT to_regtype($1)::oid::text AS oid", [
            source,
          ]),
        catch: (cause: unknown) => cause,
      });
      if (result.isErr()) {
        const code = getPgErrorCode(result.error);
        if (code === "42601" || code === "42704") {
          continue;
        }
        throw result.error;
      }
      const row = result.value.at(0);
      if (isRecord(row) && typeof row["oid"] === "string") {
        oid = row["oid"];
        break;
      }
    }
    if (oid === undefined) {
      return panic("Replacement argument type cannot be resolved");
    }
    oids.push(oid);
  }
  return oids.join(" ");
};

const missingReplacementRepairs = async ({
  connection,
  migrations,
  repairs,
}: ReplacementCoverageOptions) => {
  const indexed = await connection.query(`
    SELECT DISTINCT function.oid::text AS oid, namespace.nspname AS schema, function.proname AS name,
      function.oid::regprocedure::text AS signature, function.proargtypes::text AS "argumentTypes"
    FROM pg_catalog.pg_proc function
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = function.pronamespace
    JOIN pg_catalog.pg_depend dependency ON dependency.refobjid = function.oid
    JOIN pg_catalog.pg_index index_state ON index_state.indexrelid = dependency.objid
    WHERE function.provolatile = 'i'
      AND dependency.refclassid = 'pg_catalog.pg_proc'::regclass
      AND dependency.classid = 'pg_catalog.pg_class'::regclass
  `);
  const registered = new Set<string>();
  for (const repair of repairs) {
    const row = (
      await connection.query("SELECT to_regprocedure($1)::oid::text AS oid", [
        repair.functionSignature,
      ])
    ).at(0);
    if (isRecord(row) && typeof row["oid"] === "string") {
      registered.add(`${repair.introducedBy}:${row["oid"]}`);
    }
  }
  const missing: string[] = [];
  for (const migration of migrations) {
    for (const statement of parseMigrationStatements(migration.sql)) {
      const tokens = migrationStatementTokens(statement);
      if (
        !["create", "or", "replace", "function"].every(
          (word, index) =>
            tokens.at(index)?.value === word &&
            tokens.at(index)?.kind === "word",
        )
      ) {
        continue;
      }
      const declaration = readMigrationRelation(tokens, 4);
      if (declaration === undefined) {
        return panic("A replacement function declaration has no name");
      }
      const { relation: name, next } = declaration;
      if (
        !indexed.some(
          (row) =>
            isRecord(row) &&
            row["schema"] === name.schema &&
            row["name"] === name.name,
        )
      ) {
        continue;
      }
      const argumentTypes = await replacementArgumentTypes({
        connection,
        statement,
        tokens,
        start: next,
      });
      for (const row of indexed) {
        if (
          !isRecord(row) ||
          typeof row["oid"] !== "string" ||
          typeof row["signature"] !== "string"
        ) {
          return panic("Invalid indexed immutable function catalog result");
        }
        if (
          row["schema"] === name.schema &&
          row["name"] === name.name &&
          row["argumentTypes"] === argumentTypes &&
          !registered.has(`${migration.revision}:${row["oid"]}`)
        ) {
          missing.push(`${migration.revision}: ${row["signature"]}`);
        }
      }
    }
  }
  return [...new Set(missing)].toSorted();
};

const withFixture = async (
  run: (connection: OnlineMigrationConnection) => Promise<void>,
) => {
  await withIsolatedPostgresCluster(
    {
      prefix: "function-reindex",
      database: "stella",
      user: "fixture_owner",
      password: "fixture",
    },
    async (databaseUrl) => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const database = openClient().sql;
        const connection = connectionOf(database);
        await connection.execute("CREATE ROLE stella");
        const checkpointMigration = readFileSync(
          path.resolve(
            import.meta.dir,
            "../../drizzle/20261001123000_database_backfill_state/migration.sql",
          ),
          "utf-8",
        );
        for (const statement of checkpointMigration.split(
          "--> statement-breakpoint",
        )) {
          await connection.execute(statement);
        }
        await run(connection);
      });
    },
  );
};

const installIndexes = async (connection: OnlineMigrationConnection) => {
  await connection.execute(definition);
  await connection.execute(
    "CREATE TABLE public.function_reindex_rows (value integer NOT NULL)",
  );
  await connection.execute(
    "INSERT INTO public.function_reindex_rows VALUES (1), (2), (3)",
  );
  await connection.execute(
    "CREATE INDEX function_reindex_expression ON public.function_reindex_rows (public.function_reindex_fixture(value))",
  );
  await connection.execute(
    "CREATE INDEX function_reindex_predicate ON public.function_reindex_rows (value) WHERE public.function_reindex_fixture(value) > 2",
  );
  await connection.execute(
    "CREATE INDEX function_reindex_control ON public.function_reindex_rows (value)",
  );
};

const indexFiles = async (connection: OnlineMigrationConnection) =>
  new Map(
    (
      await connection.query(
        "SELECT relname, relfilenode::text AS node FROM pg_catalog.pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'i' AND relname LIKE 'function_reindex_%'",
      )
    ).map((row) => {
      if (
        !isRecord(row) ||
        typeof row["relname"] !== "string" ||
        typeof row["node"] !== "string"
      ) {
        return panic("Invalid index storage catalog row");
      }
      return [row["relname"], row["node"]] as const;
    }),
  );

describe.skipIf(!enabled)("immutable function dependent-index rebuilds", () => {
  // timeout: initializes the owner-isolated PostgreSQL cluster and runs concurrent index DDL.
  test("catalog expression and predicate dependencies resume after an interrupted rebuild", async () => {
    await withFixture(async (connection) => {
      await installIndexes(connection);
      const indexes = await readFunctionDependentIndexes(connection, signature);
      expect(indexes).toHaveLength(2);
      const before = await indexFiles(connection);
      await connection.execute(definition.replace("value + 1", "value + 2"));
      const repair = createFunctionDependentIndexReindex({
        functionSignature: signature,
        replacementRevision: revision,
      });
      expect((await repair.readCompletion(connection)).type).toBe("incomplete");
      const gate = createUngatedTableGateForTests(connection);
      const completed: string[] = [];
      const interrupted: OnlineTableGate = {
        run: async (request) => {
          if (completed.length === 1) {
            return await Promise.reject(new Error("fixture interruption"));
          }
          const outcome = await gate.run(request);
          completed.push(request.target.name);
          return outcome;
        },
      };
      expect(
        await rejectionOf(repair.repair(connection, interrupted)),
      ).toMatchObject({ message: "fixture interruption" });
      expect((await repair.readCompletion(connection)).type).toBe("incomplete");
      expect(
        await repair.repair(connection, {
          run: async (request) => {
            const outcome = await gate.run(request);
            completed.push(request.target.name);
            return outcome;
          },
        }),
      ).toEqual({ type: "complete" });
      expect(completed).toEqual(indexes.map(({ name }) => name));
      const after = await indexFiles(connection);
      for (const { name } of indexes) {
        expect(after.get(name)).toBeDefined();
        expect(after.get(name)).not.toBe(before.get(name));
      }
      expect(after.get("function_reindex_control")).toBe(
        before.get("function_reindex_control"),
      );
      expect(await repair.readCompletion(connection)).toEqual({
        type: "complete",
      });
      let work = 0;
      await repair.repair(connection, {
        run: async () => {
          work += 1;
          return { type: "complete" };
        },
      });
      expect(work).toBe(0);
    });
  }, 30_000);

  // timeout: initializes an owner-isolated PostgreSQL cluster.
  test("an empty database completes without index work and reads completion with one primary-key lookup", async () => {
    await withFixture(async (connection) => {
      const repair = createFunctionDependentIndexReindex({
        functionSignature: signature,
        replacementRevision: revision,
      });
      let work = 0;
      await repair.repair(connection, {
        run: async () => {
          work += 1;
          return { type: "complete" };
        },
      });
      expect(work).toBe(0);
      const reads: string[] = [];
      expect(
        await repair.readCompletion({
          ...connection,
          query: async (query, params) => {
            reads.push(query);
            return await connection.query(query, params);
          },
        }),
      ).toEqual({ type: "complete" });
      expect(reads).toHaveLength(1);
      expect(reads.at(0)).toContain("WHERE name = $1");
    });
  }, 30_000);

  // timeout: initializes an owner-isolated PostgreSQL cluster and derives function dependencies.
  test("an unregistered replacement of an indexed immutable function is refused", async () => {
    await withFixture(async (connection) => {
      await installIndexes(connection);
      await connection.execute(
        definition
          .replace("value integer", "value text")
          .replace("value + 1", "length(value)"),
      );
      await connection.execute(
        "CREATE INDEX function_reindex_text ON public.function_reindex_rows (public.function_reindex_fixture(value::text))",
      );
      const migrations = [{ revision, sql: definition }];
      const missing = await missingReplacementRepairs({
        connection,
        migrations,
        repairs: [],
      });
      expect(missing).toHaveLength(1);
      expect(missing.at(0)).toContain(revision);
      const repair = createFunctionDependentIndexReindex({
        functionSignature: signature,
        replacementRevision: revision,
      });
      expect(
        await missingReplacementRepairs({
          connection,
          migrations,
          repairs: [repair],
        }),
      ).toEqual([]);
      expect(
        await missingReplacementRepairs({
          connection,
          migrations: [{ revision: `${revision}_later`, sql: definition }],
          repairs: [repair],
        }),
      ).toHaveLength(1);
      for (const sql of [
        definition
          .replace(
            "CREATE OR REPLACE FUNCTION",
            "create /* declaration */ or replace function",
          )
          .replace("value integer", "value int4 DEFAULT 1"),
        definition
          .replace(
            "public.function_reindex_fixture",
            '"public"."function_reindex_fixture"',
          )
          .replace("value integer", "INOUT value integer"),
        definition.replace(
          "value integer",
          "value integer, OUT result integer",
        ),
      ]) {
        expect(
          await missingReplacementRepairs({
            connection,
            migrations: [{ revision, sql }],
            repairs: [repair],
          }),
        ).toEqual([]);
      }
      const unindexed = definition
        .replace("value integer", "value boolean")
        .replace("value + 1", "CASE WHEN value THEN 1 ELSE 0 END");
      await connection.execute(unindexed);
      expect(
        await missingReplacementRepairs({
          connection,
          migrations: [{ revision, sql: unindexed }],
          repairs: [],
        }),
      ).toEqual([]);
    });
  }, 30_000);

  test("new immutable replacements with catalog-dependent indexes have registered rebuilds", async () => {
    const root = path.resolve(import.meta.dir, "../../../..");
    const base = process.env["CI_COMPARISON_BASE"] ?? "origin/main";
    const diff = Bun.spawnSync(
      [
        "git",
        "diff",
        "--name-only",
        "--diff-filter=AM",
        `${base}...HEAD`,
        "--",
        "apps/api/drizzle",
      ],
      { cwd: root },
    );
    if (diff.exitCode !== 0) {
      return panic(
        `Cannot enumerate replacement migrations: ${new TextDecoder().decode(diff.stderr)}`,
      );
    }
    const migrations = new TextDecoder()
      .decode(diff.stdout)
      .split("\n")
      .filter((file) => file.endsWith("/migration.sql"))
      .map((file) => ({
        revision: path.basename(path.dirname(file)),
        sql: readFileSync(path.join(root, file), "utf-8"),
      }));
    if (migrations.length === 0) {
      return;
    }
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("Catalog replacement guard requires DATABASE_URL");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      expect(
        await missingReplacementRepairs({
          connection: connectionOf(openClient().sql),
          migrations,
          repairs: FUNCTION_DEPENDENT_INDEX_REINDEXES,
        }),
      ).toEqual([]);
    });
  });
});

test("each dependent-index replacement is in the online repair registry", () => {
  for (const repair of FUNCTION_DEPENDENT_INDEX_REINDEXES) {
    expect(ONLINE_MIGRATION_REPAIRS).toContain(repair);
  }
  const filingYear = createFunctionDependentIndexReindex({
    functionSignature: CASE_LAW_FILING_YEAR_FUNCTION_SIGNATURE,
    replacementRevision: revision,
  });
  expect(filingYear.functionSignature).toBe(
    "public.decision_docket_filing_year(text,text)",
  );
  expect(filingYear.introducedBy).toBe(revision);
});
