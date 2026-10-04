import { panic } from "better-result";
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

import { readOnlineIndexConfig } from "../env-online-index";
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

const withScratch = async (
  work: (client: SQL, openClient: () => SQL) => Promise<void>,
) => {
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
          await work(client, () => openScratchClient().sql);
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
    for (const reason of ["wait", "cancel"] as const) {
      test(`a staged index ${reason} preserves the existing cutover index on PostgreSQL`, async () => {
        await withScratch(async (client, openClient) => {
          const cutover = ONLINE_MIGRATION_INDEX_CUTOVERS.at(0);
          if (cutover === undefined) {
            throw new TypeError("Expected an online index cutover");
          }
          const { final, staged } = cutover;
          await client.unsafe(
            "CREATE TABLE case_law_decisions (id uuid PRIMARY KEY, updated_at timestamptz NOT NULL)",
          );
          await client.unsafe(
            "INSERT INTO case_law_decisions VALUES ('00000000-0000-0000-0000-000000000001', now())",
          );
          await client.unsafe(
            `CREATE INDEX "${final.name}" ON case_law_decisions (updated_at, id)`,
          );
          const readFinal = async () =>
            await client.unsafe<
              { oid: number; definition: string; valid: boolean }[]
            >(
              "SELECT i.indexrelid::int AS oid, pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1",
              [final.name],
            );
          const before = await readFinal();
          expect(before).toHaveLength(1);
          expect(before.at(0)?.valid).toBe(true);
          expect(before.at(0)?.definition).not.toContain("DESC");

          const builder = await openClient().reserve();
          const observer = await openClient().reserve();
          const blocker = await openClient().reserve();
          try {
            const pid = (
              await builder.unsafe<{ pid: number }[]>(
                "SELECT pg_backend_pid() AS pid",
              )
            ).at(0)?.pid;
            if (pid === undefined) {
              throw new TypeError("Missing online builder pid");
            }
            if (reason === "cancel") {
              await blocker.unsafe("BEGIN");
              await blocker.unsafe(
                "UPDATE case_law_decisions SET updated_at = now()",
              );
            }
            const prerequisites = repairConnection(builder);
            const statements: string[] = [];
            // Only unrelated catalog prerequisites are faked. The staged build,
            // cancellation, final index, and both sessions use real PostgreSQL.
            const connection: OnlineMigrationConnection = {
              execute: async (statement, parameters = []) => {
                statements.push(statement);
                await builder.unsafe(statement, [...parameters]);
              },
              query: async (statement, parameters = []) => {
                const isCutover = [final.name, staged.name].some((name) =>
                  statement.includes("starts_with")
                    ? parameters.at(2) === `${name.slice(0, 57)}_ccnew`
                    : parameters.at(1) === name,
                );
                if (statement.includes("pg_catalog.pg_index") && !isCutover) {
                  return await prerequisites.query(statement, parameters);
                }
                return await builder.unsafe(statement, [...parameters]);
              },
              terminate: async () => {
                await builder.close({ timeout: 0 });
              },
              release: () => undefined,
            };
            let readings = 0;
            let repairs = 0;
            const now = Date.now() + 60_000;
            const config = {
              ...readOnlineIndexConfig({}),
              health: {
                ...defaultConfig,
                busyWindows: [],
                longTxMaxAgeMs: 3_600_000,
              },
              pollMs: 1,
              retryMs: 7,
            };
            const outcome = await runOnlineMigrations(
              { reserve: async () => connection },
              {
                indexGate: {
                  config,
                  clock: () => now,
                  log: () => undefined,
                  ebs: {
                    type: "reader",
                    read: async () => {
                      readings += 1;
                      const reading =
                        reason === "wait"
                          ? ({ kind: "unknown", value: null } as const)
                          : ({
                              kind: readings === 1 ? "normal" : "stop",
                              value: readings === 1 ? 100 : 1,
                            } as const);
                      return {
                        indicator: "ebs_balance",
                        ...reading,
                        threshold:
                          reading.kind === "stop"
                            ? config.health.hardFloor
                            : config.health.startFloor,
                        observedAt:
                          reading.kind === "unknown"
                            ? null
                            : new Date(now).toISOString(),
                        reason: "Injected staged build health",
                      };
                    },
                  },
                  wait: async () => {
                    for (let attempt = 0; attempt < 400; attempt += 1) {
                      const progress = await observer.unsafe<
                        { phase: string }[]
                      >(
                        "SELECT phase FROM pg_stat_progress_create_index WHERE pid = $1",
                        [pid],
                      );
                      if (
                        progress.at(0)?.phase ===
                        "waiting for writers before build"
                      ) {
                        return;
                      }
                      await Bun.sleep(5);
                    }
                    throw new TypeError(
                      "Staged index did not reach its writer barrier",
                    );
                  },
                },
                reserveObserver: async () => ({
                  execute: async (statement, parameters = []) => {
                    await observer.unsafe(statement, [...parameters]);
                  },
                  query: async (statement, parameters = []) =>
                    await observer.unsafe(statement, [...parameters]),
                  release: () => undefined,
                }),
                repairs: [
                  {
                    name: "later-repair",
                    readCompletion: async () => {
                      repairs += 1;
                      return { type: "complete" };
                    },
                    repair: async () => {
                      throw new TypeError("Completed repair ran");
                    },
                  },
                ],
              },
            );
            expect(outcome).toEqual({
              type: "deferred",
              index: staged.name,
              retryAfterMs: config.retryMs,
            });
            expect(await readFinal()).toEqual(before);
            expect(repairs).toBe(0);
            expect(
              statements.filter(
                (statement) =>
                  statement.startsWith("DROP INDEX") ||
                  statement.startsWith("ALTER INDEX"),
              ),
            ).toEqual([]);
            const stageState = await client.unsafe<{ valid: boolean }[]>(
              "SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1",
              [staged.name],
            );
            expect(stageState).toEqual(
              reason === "cancel" ? [{ valid: false }] : [],
            );
            expect(readings).toBe(reason === "cancel" ? 3 : 1);
          } finally {
            await blocker.unsafe("ROLLBACK");
            blocker.release();
            observer.release();
            builder.release();
          }
        });
      });
    }

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
            // The adapter reports every index ready, so no build observes.
            reserveObserver: () =>
              panic("Repair holds never build an online index"),
            log: (record: unknown) => {
              events.push(record);
            },
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
          await connection.release();
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
