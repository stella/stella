import type { ReservedSQL, SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import {
  getTableConfig,
  PgDialect,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { defaultConfig, type Verdict } from "@stll/db-load-gate/health";
import { Temporal } from "@stll/time";

import { CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT } from "../lib/decision-date-bounds-sql";
import { withGatedTestClients } from "../tests/gated-test-database";
import { createCorpusProjectionDeleteReceiptRepair } from "./corpus-projection-delete-receipt-repair";
import { createDecisionDateCeilingRepair } from "./decision-date-ceiling-repair";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import {
  assertOnlineMigrationsApplied,
  ONLINE_MIGRATION_INDEX_CUTOVERS,
  ONLINE_MIGRATION_INDEXES,
  runOnlineMigrations,
  type OnlineRepairOptions,
} from "./online-migrations";
import { APPLICATION_RLS_ROLE_NAME } from "./role-names";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
  corpusIndexProjectionIntents,
} from "./schema";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const dialect = new PgDialect();
const readyIndexes = [
  ...ONLINE_MIGRATION_INDEXES,
  ...ONLINE_MIGRATION_INDEX_CUTOVERS.map(({ final }) => final),
];

/** Index handling has its own suite; this adapter routes every repair query to real PG. */
const repairConnection = (
  connection: ReservedSQL,
): OnlineMigrationConnection => ({
  execute: async (statement, parameters = []) => {
    await connection.unsafe(statement, [...parameters]);
  },
  query: async (statement, parameters = []) => {
    if (statement.includes("pg_catalog.pg_index")) {
      if (statement.includes("starts_with")) {
        return [];
      }
      const index = readyIndexes.find(({ name }) => name === parameters.at(1));
      return index === undefined
        ? []
        : [
            {
              name: index.name,
              isReady: true,
              isUnique: index.isUnique,
              isValid: true,
              definition: `CREATE ${index.isUnique ? "UNIQUE " : ""}INDEX ${index.name} ${index.definitionBody}`,
            },
          ];
    }
    return await connection.unsafe(statement, [...parameters]);
  },
  release: () => connection.release(),
});

const withScratch = async (work: (client: SQL) => Promise<void>) => {
  if (databaseUrl === undefined) {
    throw new TypeError("DATABASE_URL required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const admin = openClient().sql;
    await admin.unsafe(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APPLICATION_RLS_ROLE_NAME}') THEN CREATE ROLE "${APPLICATION_RLS_ROLE_NAME}" NOLOGIN; END IF; END $$`,
    );
    const name = `repair_hold_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    try {
      const url = new URL(databaseUrl);
      url.pathname = `/${name}`;
      await withGatedTestClients(
        url.toString(),
        async ({ openClient: openScratchClient }) => {
          const client = openScratchClient().sql;
          const version = (
            await client.unsafe<{ version: number }[]>(
              "SELECT current_setting('server_version_num')::int AS version",
            )
          ).at(0);
          expect(version?.version).toBeGreaterThanOrEqual(180_000);
          expect(version?.version).toBeLessThan(190_000);
          const migration = await Bun.file(
            new URL(
              "../../drizzle/20261001123000_database_backfill_state/migration.sql",
              import.meta.url,
            ),
          ).text();
          for (const statement of migration.split("--> statement-breakpoint")) {
            await client.unsafe(statement);
          }
          await work(client);
        },
      );
    } finally {
      await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    }
  });
};

const createFixture = async (client: SQL, kind: "date" | "receipt") => {
  const createTable = async (name: string, columns: readonly AnyPgColumn[]) => {
    // The fixture uses the real owner columns and SQL types instead of mirroring a schema.
    await client.unsafe(
      `CREATE TABLE "${name}" (${columns.map((column) => `"${column.name}" ${column.getSQLType()}`).join(", ")}, repair_count int NOT NULL DEFAULT 0)`,
    );
  };
  if (kind === "date") {
    await createTable(getTableName(caseLawSources), [
      caseLawSources.id,
      caseLawSources.adapterKey,
    ]);
    await createTable(getTableName(caseLawDecisions), [
      caseLawDecisions.id,
      caseLawDecisions.sourceId,
      caseLawDecisions.decisionDate,
      caseLawDecisions.country,
      caseLawDecisions.citationKey,
      caseLawDecisions.metadata,
    ]);
    await createTable(getTableName(caseLawCitations), [
      caseLawCitations.id,
      caseLawCitations.citingDecisionId,
      caseLawCitations.citedDecisionId,
      caseLawCitations.resolutionRuleId,
      caseLawCitations.resolutionStatus,
    ]);
    await client.unsafe(
      "INSERT INTO case_law_sources (id, adapter_key) VALUES ('00000000-0000-0000-0000-000000000001', 'cz-regional')",
    );
    await client.unsafe(
      "INSERT INTO case_law_decisions (id, source_id, country, decision_date) SELECT md5(i::text)::uuid, '00000000-0000-0000-0000-000000000001'::uuid, 'CZE', '9999-01-01'::date FROM generate_series(1, 100) i",
    );
  } else {
    await createTable(getTableName(corpusIndexProjectionIntents), [
      corpusIndexProjectionIntents.id,
      corpusIndexProjectionIntents.deleteOpstamp,
      corpusIndexProjectionIntents.deleteTaskCreatedAt,
      corpusIndexProjectionIntents.updatedAt,
    ]);
    await client.unsafe(
      "INSERT INTO corpus_index_projection_intents (id, delete_opstamp, updated_at) SELECT md5(i::text)::uuid, 1, '2026-01-01T00:00:00Z'::timestamptz FROM generate_series(1, 1001) i",
    );
  }
  const table =
    kind === "date" ? caseLawDecisions : corpusIndexProjectionIntents;
  const checkName =
    kind === "date"
      ? CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT
      : "corpus_index_projection_intents_delete_receipt_paired";
  const check = getTableConfig(table).checks.find(
    ({ name }) => name === checkName,
  );
  if (check === undefined) {
    throw new TypeError("Repair constraint missing from schema owner");
  }
  const constraint = dialect.sqlToQuery(check.value);
  expect(constraint.params).toHaveLength(0);
  const tableName = getTableName(table);
  await client.unsafe(
    `ALTER TABLE "${tableName}" ADD CONSTRAINT "${checkName}" CHECK (${constraint.sql}) NOT VALID`,
  );
  const column =
    kind === "date"
      ? caseLawDecisions.decisionDate.name
      : corpusIndexProjectionIntents.deleteTaskCreatedAt.name;
  await client.unsafe(
    "CREATE FUNCTION count_repair() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.repair_count := OLD.repair_count + 1; RETURN NEW; END $$",
  );
  await client.unsafe(
    `CREATE TRIGGER repair_counter BEFORE UPDATE OF "${column}" ON "${tableName}" FOR EACH ROW WHEN (OLD."${column}" IS DISTINCT FROM NEW."${column}") EXECUTE FUNCTION count_repair()`,
  );
  await client.unsafe(
    `CREATE TABLE oracle AS SELECT id, ${kind === "date" ? "NULL::date" : "updated_at"} AS expected FROM "${tableName}"`,
  );
  return {
    tableName,
    column,
    firstBatch: kind === "date" ? 50 : 1000,
    total: kind === "date" ? 100 : 1001,
  };
};

describe.skipIf(!enabled)(
  "online repairs survive durable holds on PostgreSQL 18",
  () => {
    for (const kind of ["date", "receipt"] as const) {
      test(`${kind} repair deploys pending and resumes its committed batch exactly once`, async () => {
        await withScratch(async (client) => {
          const fixture = await createFixture(client, kind);
          let now = Date.parse("2026-10-01T12:00:00Z");
          let readings = 0;
          let resume = false;
          const decisions: unknown[] = [];
          const events: unknown[] = [];
          const readVerdict = async (): Promise<Verdict> => {
            readings += 1;
            const signalKind = resume || readings === 1 ? "normal" : "unknown";
            return {
              kind: signalKind,
              signals: [
                {
                  indicator: "ebs_balance",
                  kind: signalKind,
                  value: signalKind === "normal" ? 90 : null,
                  threshold: defaultConfig.startFloor,
                  observedAt:
                    Temporal.Instant.fromEpochMilliseconds(now).toString(),
                  reason: "Injected batch boundary health",
                },
              ],
            };
          };
          const options = {
            clock: () => now,
            readVerdict,
            sleep: async () => {
              await Promise.resolve();
            },
            log: (record: unknown) => {
              decisions.push(record);
            },
          };
          const repair =
            kind === "date"
              ? createDecisionDateCeilingRepair(options)
              : createCorpusProjectionDeleteReceiptRepair(options);
          const pool = {
            reserve: async () => repairConnection(await client.reserve()),
          };
          const runnerOptions = {
            repairs: [repair],
            indexGate: { ebs: { type: "disabled" } },
            log: (record: unknown) => events.push(record),
          } satisfies OnlineRepairOptions;
          await runOnlineMigrations(pool, runnerOptions);
          const processed = (
            await client.unsafe<{ processed: number }[]>(
              `SELECT sum(repair_count)::int AS processed FROM "${fixture.tableName}"`,
            )
          ).at(0)?.processed;
          expect(processed).toBe(fixture.firstBatch);
          const connection = repairConnection(await client.reserve());
          const pending = await repair.readCompletion(connection);
          connection.release();
          expect(pending).toMatchObject({
            type: "pending",
            heldSince: now,
            holdUntil: now + defaultConfig.holdBackoffMs,
          });
          if (pending.type !== "pending" || pending.holdUntil === null) {
            throw new TypeError("Repair hold lacks a durable deadline");
          }
          if (kind === "receipt") {
            const cursorCount = (
              await client.unsafe<{ count: number }[]>(
                `SELECT count(*)::int AS count FROM "${fixture.tableName}" WHERE id <= $1::uuid`,
                [pending.cursor],
              )
            ).at(0)?.count;
            expect(cursorCount).toBe(fixture.firstBatch);
          }
          await assertOnlineMigrationsApplied(pool, runnerOptions);
          expect(events).toHaveLength(2);
          for (const event of events) {
            expect(structuredClone(event)).toMatchObject({
              event: "online_repair_pending",
              completion: {
                type: "pending",
                holdUntil: expect.any(Number),
                heldSince: expect.any(Number),
              },
            });
          }
          resume = true;
          now = pending.holdUntil;
          await runOnlineMigrations(pool, runnerOptions);
          await assertOnlineMigrationsApplied(pool, runnerOptions);
          await runOnlineMigrations(pool, runnerOptions);
          const counts = (
            await client.unsafe<{ count: number; once: number }[]>(
              `SELECT count(*)::int AS count, count(*) FILTER (WHERE repair_count = 1)::int AS once FROM "${fixture.tableName}"`,
            )
          ).at(0);
          expect(counts).toEqual({ count: fixture.total, once: fixture.total });
          const differences = await client.unsafe(
            `(SELECT id, "${fixture.column}" FROM "${fixture.tableName}" EXCEPT SELECT id, expected FROM oracle) UNION ALL (SELECT id, expected FROM oracle EXCEPT SELECT id, "${fixture.column}" FROM "${fixture.tableName}")`,
          );
          expect(differences).toHaveLength(0);
          for (const record of decisions) {
            // Bun replaces nested values with asymmetric matchers; preserve shared verdicts.
            expect(structuredClone(record)).toMatchObject({
              config: { hardFloor: defaultConfig.hardFloor },
              verdict: { signals: expect.any(Array) },
            });
          }
        });
      });
    }
  },
);
