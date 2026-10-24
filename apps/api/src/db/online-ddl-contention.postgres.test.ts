import { panic } from "better-result";
import type { ReservedSQL, SQL } from "bun";
import { describe, expect, test } from "bun:test";

import { defaultConfig } from "@stll/db-load-gate/health";
import { waitForExternalState } from "@stll/property-testing/external-state";

import type { OnlineIndexConfig } from "../env-online-index";
import { isRecord } from "../lib/type-guards";
import { withGatedTestClients } from "../tests/gated-test-database";
import {
  createEntityFeatureGateRepair,
  ENTITY_FEATURE_GATE_CONSTRAINT_NAMES,
} from "./entity-feature-gate-repair";
import {
  createOnlineTableGate,
  declaresOnlineBuild,
  validateOnlineConstraints,
} from "./online-ddl";
import type { PolicyDefinition } from "./online-ddl";
import type { OnlineIndexGateOptions } from "./online-index-gate";
import type {
  OnlineMigrationConnection,
  OnlineMigrationOutcome,
} from "./online-migration-connection";
import {
  completeIndexCutover,
  ensureOnlineIndexValid,
  ONLINE_CONSTRAINT_VALIDATIONS,
  ONLINE_INDEX_REPLACEMENTS,
  ONLINE_MIGRATION_INDEX_CUTOVERS,
  ONLINE_MIGRATION_INDEXES,
  replacementTableName,
  retireOnlineIndex,
} from "./online-migrations";
import { terminateReserved } from "./sql-close";

/**
 * Every table-locking step the online phase declares, on PostgreSQL 18, under
 * the transaction that contends with it on a real table: a writer for index
 * work, a SHARE UPDATE EXCLUSIVE holder (what an autovacuum or an ANALYZE
 * holds) for validations. Each step runs on a session with the phase's own
 * one-second lock budget, defers instead of failing while the contender holds
 * its table, completes once the contender commits, and is a no-op when run
 * again. The tables are minimal copies, in a scratch database, of the columns
 * the declarations name, with the types the migrated test database gives them,
 * so each declared build is also checked against its declared definition.
 */

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

/** The extra column every fixture table carries for its CHECK constraints. */
const PROBE_COLUMN = "online_ddl_probe";
const ENTITY_TABLE = "online_ddl_entities";
const RETRY_MS = 2;

type Contention = "writer" | "maintenance";

const CONTENDING_LOCK = {
  writer: "ROW EXCLUSIVE",
  maintenance: "SHARE UPDATE EXCLUSIVE",
} as const satisfies Record<Contention, string>;

type Scratch = {
  owner: ReservedSQL;
  builder: ReservedSQL;
  observer: ReservedSQL;
  blocker: ReservedSQL;
  pid: number;
  connection: OnlineMigrationConnection;
  executed: string[];
  reserveObserver: () => Promise<OnlineMigrationConnection>;
  clock: () => number;
};

const adapter = (
  connection: ReservedSQL,
  executed: string[] = [],
): OnlineMigrationConnection => ({
  query: async (statement, parameters = []) =>
    await connection.unsafe<unknown[]>(statement, [...parameters]),
  execute: async (statement, parameters = []) => {
    executed.push(statement);
    await connection.unsafe(statement, [...parameters]);
  },
  release: async () => {
    await connection.release();
  },
  terminate: async () => {
    await terminateReserved(connection);
  },
});

const quoted = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

/** Every table a declaration names, with the texts that name its columns. */
const declaredTables = (): Map<string, string[]> => {
  const tables = new Map<string, string[]>();
  const declare = (tableName: string, ...texts: (string | undefined)[]) => {
    tables.set(tableName, [
      ...(tables.get(tableName) ?? []),
      ...texts.filter((text) => text !== undefined),
    ]);
  };
  for (const index of ONLINE_MIGRATION_INDEXES) {
    declare(index.tableName, index.definitionBody, index.createSql);
  }
  for (const { final, staged } of ONLINE_MIGRATION_INDEX_CUTOVERS) {
    declare(final.tableName, final.definitionBody);
    declare(staged.tableName, staged.definitionBody, staged.createSql);
  }
  for (const { tableName } of ONLINE_CONSTRAINT_VALIDATIONS) {
    declare(tableName);
  }
  return tables;
};

const rowsOf = (rows: unknown): Record<string, unknown>[] =>
  Array.isArray(rows) ? rows.filter((row) => isRecord(row)) : [];

const stringField = (row: Record<string, unknown>, field: string): string => {
  const value = row[field];
  return typeof value === "string"
    ? value
    : panic(`Catalog row has no string ${field}`);
};

/**
 * The scratch schema: extensions, enum types and functions the declarations
 * use, read from the migrated test database, then one table per declared
 * table with the columns its declarations name (and `id`, which the legacy and
 * stale fixture indexes are built on) plus the probe column.
 */
const installFixtureSchema = async (main: SQL, owner: ReservedSQL) => {
  const statements: string[] = [];
  const installed = new Set<string>();
  const once = (key: string, statement: string) => {
    if (!installed.has(key)) {
      installed.add(key);
      statements.push(statement);
    }
  };
  const tables = declaredTables();
  const texts = [...tables.values()].flat().join("\n");
  for (const [, opclass] of texts.matchAll(/\b([a-z0-9_]+_ops)\b/gu)) {
    for (const row of rowsOf(
      await main.unsafe(
        `SELECT x.extname AS name FROM pg_catalog.pg_opclass c
         JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_opclass'::regclass
           AND d.objid = c.oid AND d.deptype = 'e'
         JOIN pg_catalog.pg_extension x ON x.oid = d.refobjid
         WHERE c.opcname = $1`,
        [opclass],
      ),
    )) {
      const name = stringField(row, "name");
      once(
        `extension:${name}`,
        `CREATE EXTENSION IF NOT EXISTS ${quoted(name)}`,
      );
    }
  }
  const tableStatements: string[] = [];
  for (const [tableName, tableTexts] of tables) {
    const columns = rowsOf(
      await main.unsafe(
        `SELECT a.attname AS name,
           format_type(a.atttypid, a.atttypmod) AS type,
           base.typtype::text AS kind,
           base_namespace.nspname AS schema,
           base.typname AS "typeName",
           (SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder)
              FROM pg_catalog.pg_enum e WHERE e.enumtypid = base.oid) AS labels,
           (SELECT x.extname FROM pg_catalog.pg_depend d
              JOIN pg_catalog.pg_extension x ON x.oid = d.refobjid
              WHERE d.classid = 'pg_catalog.pg_type'::regclass
                AND d.objid = base.oid AND d.deptype = 'e') AS extension
         FROM pg_catalog.pg_attribute a
         JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
         JOIN pg_catalog.pg_type base
           ON base.oid = CASE WHEN t.typcategory = 'A' THEN t.typelem ELSE t.oid END
         JOIN pg_catalog.pg_namespace base_namespace ON base_namespace.oid = base.typnamespace
         WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
        [`public.${quoted(tableName)}`],
      ),
    );
    if (columns.length === 0 && tableTexts.length > 0) {
      panic(`The migrated test database has no table ${tableName}`);
    }
    const named = columns.filter((column) => {
      const name = stringField(column, "name");
      return (
        name === "id" ||
        tableTexts.some((text) => new RegExp(`\\b${name}\\b`, "u").test(text))
      );
    });
    for (const column of named) {
      const schema = stringField(column, "schema");
      const extension = column["extension"];
      if (typeof extension === "string") {
        once(
          `extension:${extension}`,
          `CREATE EXTENSION IF NOT EXISTS ${quoted(extension)}`,
        );
      } else if (column["kind"] === "e") {
        const typeName = `${quoted(schema)}.${quoted(stringField(column, "typeName"))}`;
        once(
          `schema:${schema}`,
          `CREATE SCHEMA IF NOT EXISTS ${quoted(schema)}`,
        );
        once(
          `type:${typeName}`,
          `CREATE TYPE ${typeName} AS ENUM (${stringField(column, "labels")})`,
        );
      } else if (schema !== "pg_catalog") {
        panic(
          `Fixture column ${tableName}.${stringField(column, "name")} has an unsupported type`,
        );
      }
    }
    tableStatements.push(
      `CREATE TABLE public.${quoted(tableName)} (${[
        ...named.map(
          (column) =>
            `${quoted(stringField(column, "name"))} ${stringField(column, "type")}`,
        ),
        `${PROBE_COLUMN} integer`,
      ].join(", ")})`,
    );
  }
  for (const [, functionName] of texts.matchAll(
    /\b([a-z_][a-z0-9_]*)\s*\(/gu,
  )) {
    const matchedName =
      functionName ??
      panic("installFixtureSchema: missing matched function name");
    for (const row of rowsOf(
      await main.unsafe(
        `SELECT pg_get_functiondef(p.oid) AS definition
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = $1`,
        [matchedName],
      ),
    )) {
      once(`function:${matchedName}`, stringField(row, "definition"));
    }
  }
  for (const statement of [...statements, ...tableStatements]) {
    await owner.unsafe(statement);
  }
};

const withScratch = async (work: (scratch: Scratch) => Promise<void>) => {
  if (databaseUrl === undefined) {
    return panic("DATABASE_URL is required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const main = openClient().sql;
    const name = `online_ddl_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    await main.unsafe(`CREATE DATABASE ${quoted(name)}`);
    try {
      const url = new URL(databaseUrl);
      url.pathname = `/${name}`;
      await withGatedTestClients(
        url.toString(),
        async ({ openClient: openScratchClient }) => {
          const owner = await openScratchClient().sql.reserve();
          const builder = await openScratchClient().sql.reserve();
          const observer = await openScratchClient().sql.reserve();
          const blocker = await openScratchClient().sql.reserve();
          try {
            const version = await owner<
              { version: string }[]
            >`SELECT current_setting('server_version') AS version`;
            expect(version.at(0)?.version).toMatch(/^18\./u);
            await installFixtureSchema(main, owner);
            const pid = (
              await builder<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
            ).at(0)?.pid;
            const now = (
              await observer<
                { now: number }[]
              >`SELECT extract(epoch FROM clock_timestamp())::double precision * 1000 AS now`
            ).at(0)?.now;
            if (pid === undefined || now === undefined) {
              return panic("Missing scratch session state");
            }
            // Ahead of the database clock, so no catalog reading is in the
            // future; advancing, so a held wait has a duration.
            const offset = now + 60_000 - Date.now();
            const executed: string[] = [];
            const connection = adapter(builder, executed);
            // The phase's own budget: an ungated table lock fails within it.
            await connection.execute("SET lock_timeout = '1s'");
            executed.length = 0;
            await work({
              owner,
              builder,
              observer,
              blocker,
              pid,
              connection,
              executed,
              reserveObserver: async () => ({
                ...adapter(observer),
                release: () => undefined,
              }),
              clock: () => Date.now() + offset,
            });
            return undefined;
          } finally {
            await blocker`ROLLBACK`;
            await owner.release();
            await builder.release();
            await observer.release();
            await blocker.release();
          }
        },
        { closeMode: "force" },
      );
    } finally {
      await main.unsafe(`DROP DATABASE ${quoted(name)}`);
    }
  });
  return undefined;
};

const healthyEbs = (clock: () => number): OnlineIndexGateOptions["ebs"] => ({
  type: "reader",
  read: async () => ({
    indicator: "ebs_balance",
    kind: "normal",
    value: 100,
    threshold: 70,
    observedAt: new Date(clock()).toISOString(),
    reason: "injected healthy metric",
  }),
});

const gateConfig = (maxSnapshotWaitMs: number): OnlineIndexConfig => ({
  health: { ...defaultConfig, busyWindows: [], longTxMaxAgeMs: 3_600_000 },
  pollMs: 1,
  retryMs: RETRY_MS,
  maxSnapshotWaitMs,
  clientConnectionCheckMs: 10,
  idleHolderMs: 3_600_000,
  longHolderMs: 3_600_000,
  parallelWorkers: 1,
  maintenanceWorkMemMb: 16,
});

/** No poll before the work finishes, so nothing cancels it. */
const untilDone = async (_milliseconds: number, signal: AbortSignal) => {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
};

const healthyGate = ({ clock }: Scratch): OnlineIndexGateOptions => ({
  config: gateConfig(600_000),
  clock,
  ebs: healthyEbs(clock),
  wait: untilDone,
  log: () => undefined,
});

/**
 * Polls only once the step's statement waits on the contender, and allows no
 * wait at all, so the watchdog cancels the statement it finds waiting.
 */
const contendedGate = (
  { clock, observer, pid }: Scratch,
  records: unknown[],
): OnlineIndexGateOptions => ({
  config: gateConfig(0),
  clock,
  ebs: healthyEbs(clock),
  wait: async (_milliseconds, signal) => {
    await waitForExternalState({
      description: `backend ${String(pid)} waits on the contender`,
      intervalMs: 5,
      timeoutMs: 2000,
      read: async () =>
        signal.aborted ||
        (
          await observer<
            { waiting: boolean }[]
          >`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = ${pid} AND wait_event_type = 'Lock') AS waiting`
        ).at(0)?.waiting === true,
      // Proceeds either way: the gate under test decides what a missing
      // wait means.
      onTimeout: () => undefined,
    });
  },
  log: (record) => {
    records.push(record);
  },
});

const contend = async (
  { blocker }: Scratch,
  tableName: string,
  contention: Contention,
) => {
  await blocker`BEGIN`;
  await blocker.unsafe(
    `LOCK TABLE public.${quoted(tableName)} IN ${CONTENDING_LOCK[contention]} MODE`,
  );
};

type StepOptions = {
  scratch: Scratch;
  name: string;
  tableName: string;
  contention: Contention;
  run: (gate: OnlineIndexGateOptions) => Promise<OnlineMigrationOutcome>;
  /** Whether a run after completion must leave the table untouched. */
  rerunIsNoop?: boolean;
};

/**
 * Deferred while the contender holds the table, complete once it commits,
 * and, run again, a catalog read that executes nothing.
 */
const expectDefersThenCompletes = async ({
  scratch,
  name,
  tableName,
  contention,
  run,
  rerunIsNoop = true,
}: StepOptions) => {
  const records: unknown[] = [];
  await contend(scratch, tableName, contention);
  try {
    expect(await run(contendedGate(scratch, records)), name).toEqual({
      type: "deferred",
      step: name,
      retryAfterMs: RETRY_MS,
    });
  } finally {
    await scratch.blocker`COMMIT`;
  }
  expect(
    records.some(
      (record) =>
        isRecord(record) &&
        isRecord(record["record"]) &&
        record["record"]["reason"] === "Snapshot wait watchdog",
    ),
    `${name} was deferred by its watchdog`,
  ).toBe(true);
  expect(await run(healthyGate(scratch)), name).toEqual({ type: "complete" });
  scratch.executed.length = 0;
  expect(await run(healthyGate(scratch)), name).toEqual({ type: "complete" });
  if (rerunIsNoop) {
    expect(scratch.executed, name).toEqual([]);
  }
  const budget = await scratch.builder<
    { timeout: string }[]
  >`SELECT current_setting('lock_timeout') AS timeout`;
  expect(budget.at(0)?.timeout, name).toBe("1s");
};

/**
 * Leaves the index INVALID the way the hazard does: a concurrent build that
 * runs into the writer under a short lock budget fails after PostgreSQL
 * recorded it.
 */
const failBuildUnderWriter = async (
  { owner }: Scratch,
  {
    name,
    tableName,
    isUnique,
    definitionBody,
  }: (typeof ONLINE_MIGRATION_INDEXES)[number],
) => {
  await owner`SET lock_timeout = '100ms'`;
  const failed = await owner
    .unsafe(
      `CREATE ${isUnique ? "UNIQUE " : ""}INDEX CONCURRENTLY ${quoted(name)} ${definitionBody}`,
    )
    .then(
      () => false,
      () => true,
    );
  await owner`RESET lock_timeout`;
  expect(failed, `${name} build under the writer`).toBe(true);
  const state = await owner<
    { valid: boolean }[]
  >`SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = ${name} AND i.indrelid = ${`public.${quoted(tableName)}`}::regclass`;
  expect(state.at(0)?.valid, name).toBe(false);
};

describe.skipIf(!enabled)("online lock-taking steps under contention", () => {
  test("every declared index builds, or repairs, under a writer by deferring", async () => {
    await withScratch(async (scratch) => {
      for (const index of ONLINE_MIGRATION_INDEXES) {
        // A schema migration builds an index with no declared build; the
        // phase only repairs it, so the fixture starts it INVALID.
        if (!declaresOnlineBuild(index)) {
          await contend(scratch, index.tableName, "writer");
          try {
            await failBuildUnderWriter(scratch, index);
          } finally {
            await scratch.blocker`COMMIT`;
          }
        }
        await expectDefersThenCompletes({
          scratch,
          name: index.name,
          tableName: index.tableName,
          contention: "writer",
          run: async (gate) =>
            await ensureOnlineIndexValid({
              connection: scratch.connection,
              index,
              gate,
              reserveObserver: scratch.reserveObserver,
            }),
        });
      }
    });
  }, 120_000);

  test("every declared cutover replaces a stale final index under a writer by deferring", async () => {
    await withScratch(async (scratch) => {
      expect(ONLINE_MIGRATION_INDEX_CUTOVERS.length).toBeGreaterThan(0);
      for (const cutover of ONLINE_MIGRATION_INDEX_CUTOVERS) {
        const { final, staged } = cutover;
        await scratch.owner.unsafe(
          `CREATE INDEX ${quoted(final.name)} ON public.${quoted(final.tableName)} (${PROBE_COLUMN})`,
        );
        await expectDefersThenCompletes({
          scratch,
          // The staged build is the first step the writer holds.
          name: staged.name,
          tableName: final.tableName,
          contention: "writer",
          run: async (gate) =>
            await completeIndexCutover({
              connection: scratch.connection,
              cutover,
              gate,
              reserveObserver: scratch.reserveObserver,
            }),
        });
        const states = await scratch.owner<
          { name: string; definition: string }[]
        >`SELECT c.relname AS name, pg_get_indexdef(c.oid) AS definition FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname IN (${final.name}, ${staged.name})`;
        expect(states.map(({ name }) => name)).toEqual([final.name]);
        expect(states.at(0)?.definition).toEndWith(final.definitionBody);
      }
    });
  }, 60_000);

  test("every replaced index retires under a writer by deferring", async () => {
    await withScratch(async (scratch) => {
      expect(ONLINE_INDEX_REPLACEMENTS.length).toBeGreaterThan(0);
      for (const replacement of ONLINE_INDEX_REPLACEMENTS) {
        const { legacyName } = replacement;
        const tableName = replacementTableName(replacement);
        await scratch.owner.unsafe(
          `CREATE INDEX ${quoted(legacyName)} ON public.${quoted(tableName)} (${PROBE_COLUMN})`,
        );
        await expectDefersThenCompletes({
          scratch,
          name: legacyName,
          tableName,
          contention: "writer",
          run: async (gate) =>
            await retireOnlineIndex({
              connection: scratch.connection,
              index: { name: legacyName, tableName },
              gate,
              reserveObserver: scratch.reserveObserver,
            }),
        });
        const left = await scratch.owner<
          { count: number }[]
        >`SELECT count(*)::integer AS count FROM pg_class WHERE relname = ${legacyName}`;
        expect(left.at(0)?.count, legacyName).toBe(0);
      }
    });
  }, 60_000);

  test("every declared constraint validates under a maintenance lock by deferring", async () => {
    await withScratch(async (scratch) => {
      expect(ONLINE_CONSTRAINT_VALIDATIONS.length).toBeGreaterThan(0);
      for (const constraint of ONLINE_CONSTRAINT_VALIDATIONS) {
        const { tableName, constraintName } = constraint;
        await scratch.owner.unsafe(
          `ALTER TABLE public.${quoted(tableName)} ADD CONSTRAINT ${quoted(constraintName)} CHECK (${PROBE_COLUMN} IS NULL OR ${PROBE_COLUMN} >= 0) NOT VALID`,
        );
        await expectDefersThenCompletes({
          scratch,
          name: constraintName,
          tableName,
          contention: "maintenance",
          run: async (gate) =>
            await validateOnlineConstraints({
              connection: scratch.connection,
              tables: createOnlineTableGate({
                connection: scratch.connection,
                gate,
                reserveObserver: scratch.reserveObserver,
              }),
              constraints: [constraint],
            }),
        });
        const validated = await scratch.owner<
          { validated: boolean }[]
        >`SELECT convalidated AS validated FROM pg_constraint WHERE conname = ${constraintName}`;
        expect(validated.at(0)?.validated, constraintName).toBe(true);
      }
    });
  }, 60_000);

  test("the entity feature gate analyzes and validates each relation under a maintenance lock, and cuts its policy over under a writer, by deferring", async () => {
    await withScratch(async (scratch) => {
      const gatePolicy = `"${ENTITY_TABLE}"."entity_feature_gate" = 'open'`;
      const policy: PolicyDefinition = {
        tableName: ENTITY_TABLE,
        name: "workspace_entity_feature",
        as: "restrictive",
        for: "all",
        role: "stella",
        using: gatePolicy,
        withCheck: gatePolicy,
      };
      const legacyPolicy = `CREATE POLICY workspace_entity_feature ON public.${ENTITY_TABLE} AS RESTRICTIVE FOR ALL TO stella USING (true) WITH CHECK (true)`;
      // The repair reads its relations, and their backfill state, from the
      // functions its migration installs; these stand-ins report one fully
      // backfilled relation, still on its legacy policy.
      for (const statement of [
        `CREATE TABLE public.${ENTITY_TABLE} (id integer PRIMARY KEY, entity_feature_gate text, ${PROBE_COLUMN} integer)`,
        `CREATE FUNCTION public.entity_feature_gate_graph() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_build_object('${ENTITY_TABLE}', jsonb_build_object('order', 1, 'primaryKey', jsonb_build_array('id'))) $$`,
        `CREATE FUNCTION public.entity_feature_gate_backfill(relation text, after text, size integer) RETURNS TABLE ("cursor" text, "count" integer, pending boolean) LANGUAGE sql AS $$ SELECT NULL::text, 0, false $$`,
        ...ENTITY_FEATURE_GATE_CONSTRAINT_NAMES.map(
          (constraintName) =>
            `ALTER TABLE public.${ENTITY_TABLE} ADD CONSTRAINT ${quoted(constraintName)} CHECK (${PROBE_COLUMN} IS NULL OR ${PROBE_COLUMN} >= 0) NOT VALID`,
        ),
        legacyPolicy,
      ]) {
        await scratch.owner.unsafe(statement);
      }
      const repair = createEntityFeatureGateRepair({
        readPolicies: () => [policy],
      });
      const run = async (gate: OnlineIndexGateOptions) =>
        await repair.repair(
          scratch.connection,
          createOnlineTableGate({
            connection: scratch.connection,
            gate,
            reserveObserver: scratch.reserveObserver,
          }),
        );
      const readPolicy = async () =>
        (
          await scratch.owner<
            { qual: string }[]
          >`SELECT qual FROM pg_policies WHERE tablename = ${ENTITY_TABLE} AND policyname = 'workspace_entity_feature'`
        ).map(({ qual }) => qual);
      await expectDefersThenCompletes({
        scratch,
        name: `${ENTITY_TABLE}.entity_feature_gate`,
        tableName: ENTITY_TABLE,
        contention: "maintenance",
        run,
        // Until its cutover, every call refreshes the relation's statistics;
        // the phase stops calling it once the policies are in place.
        rerunIsNoop: false,
      });
      const validated = await scratch.owner<
        { validated: boolean }[]
      >`SELECT bool_and(convalidated) AS validated FROM pg_constraint WHERE conrelid = ${`public.${ENTITY_TABLE}`}::regclass AND contype = 'c'`;
      expect(validated.at(0)?.validated).toBe(true);
      expect(await readPolicy()).toEqual([
        `(entity_feature_gate = 'open'::text)`,
      ]);

      const cutover = `${ENTITY_TABLE}.workspace_entity_feature`;
      await scratch.owner.unsafe(
        `DROP POLICY workspace_entity_feature ON public.${ENTITY_TABLE}`,
      );
      await scratch.owner.unsafe(legacyPolicy);
      // Unwatched, the replacement's bounded retry ladder runs out behind
      // the writer, so it defers with the legacy policy still in place.
      await contend(scratch, ENTITY_TABLE, "writer");
      try {
        expect(await run(healthyGate(scratch))).toEqual({
          type: "deferred",
          step: cutover,
          retryAfterMs: RETRY_MS,
        });
      } finally {
        await scratch.blocker`COMMIT`;
      }
      expect(await readPolicy()).toEqual(["true"]);
      await expectDefersThenCompletes({
        scratch,
        name: cutover,
        tableName: ENTITY_TABLE,
        contention: "writer",
        run,
        rerunIsNoop: false,
      });
      expect(await readPolicy()).toEqual([
        `(entity_feature_gate = 'open'::text)`,
      ]);
      // A cut-over relation costs the rerun one catalog read.
      scratch.executed.length = 0;
      expect(await run(healthyGate(scratch))).toEqual({ type: "complete" });
      expect(
        scratch.executed.filter((statement) => statement.includes("POLICY")),
      ).toEqual([]);
    });
  }, 60_000);
});
