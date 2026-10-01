import type { SQL, TransactionSQL } from "bun";
import { describe, expect, test } from "bun:test";

import { defaultConfig, initialBatchState } from "@stll/db-load-gate/health";
import type { BatchState, Verdict } from "@stll/db-load-gate/health";
import { tryAcquireBackfillTransactionSlot } from "@stll/db-load-gate/slot";

import { isPgError, PG_ERROR } from "../lib/pg-error";
import type { IngestionTransactionRunner } from "../lib/replay-safe-ingestion";
import { withGatedTestClients } from "../tests/gated-test-database";
import { runAdaptiveBackfillBatch } from "./adaptive-backfill";
import { BackfillHeldError, createBackfillRuntime } from "./backfill-runtime";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const config = {
  ...defaultConfig,
  minSize: 1,
  maxSize: 12,
  minSleepMs: 0,
  maxSleepMs: 0,
  busyWindows: [],
};
const healthy: Verdict = {
  kind: "normal",
  signals: [
    {
      indicator: "ebs_balance",
      kind: "normal",
      value: 90,
      threshold: config.startFloor,
      observedAt: "2026-10-01T12:00:00.000Z",
      reason: "Injected balance",
    },
  ],
};
type FixtureRow = {
  id: number;
  source: number;
  transformed: number;
  applications: number;
};
type StateRow = { cursor: number; batch: BatchState };

const withFixture = async (
  work: (fixture: {
    run: (options?: {
      verdict?: Verdict;
      failHalfway?: boolean;
      timeoutHalfway?: boolean;
      killHalfway?: boolean;
    }) => Promise<unknown>;
    client: SQL;
    writer: SQL;
    schema: string;
    restart: () => void;
    advanceClock: (milliseconds: number) => void;
    invariant: (complete?: boolean) => Promise<void>;
  }) => Promise<void>,
) => {
  if (databaseUrl === undefined) {
    throw new TypeError("DATABASE_URL required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    let client = openClient().sql;
    const writer = openClient().sql;
    const schema = `backfill_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    const records: unknown[] = [];
    let now = Date.parse("2026-10-01T12:00:00.000Z");
    await client.unsafe(`CREATE SCHEMA ${schema}`);
    try {
      const version = await client.unsafe<{ version: number }[]>(
        "SELECT current_setting('server_version_num')::int AS version",
      );
      expect(version[0]?.version).toBeGreaterThanOrEqual(180_000);
      expect(version[0]?.version).toBeLessThan(190_000);
      await client.unsafe(
        `CREATE TABLE ${schema}.rows (id int PRIMARY KEY, source int NOT NULL, transformed int NOT NULL DEFAULT 0, applications int NOT NULL DEFAULT 0)`,
      );
      await client.unsafe(
        `INSERT INTO ${schema}.rows (id, source) SELECT id, id * 7 FROM generate_series(1, 12) id`,
      );
      await client.unsafe(
        `CREATE TABLE ${schema}.oracle AS SELECT id, source * 2 AS expected FROM ${schema}.rows`,
      );
      await client.unsafe(
        `CREATE TABLE ${schema}.checkpoint (singleton int PRIMARY KEY, cursor int NOT NULL, batch jsonb NOT NULL)`,
      );
      await client.unsafe(
        `INSERT INTO ${schema}.checkpoint VALUES (1, 0, $1::text::jsonb)`,
        [JSON.stringify({ ...initialBatchState(config), size: 4 })],
      );
      const invariant = async (complete = false) => {
        const [state] = await client.unsafe<StateRow[]>(
          `SELECT cursor, batch FROM ${schema}.checkpoint`,
        );
        const rows = await client.unsafe<FixtureRow[]>(
          `SELECT * FROM ${schema}.rows ORDER BY id`,
        );
        for (const row of rows) {
          expect(row.applications).toBeLessThanOrEqual(1);
          if (row.id <= (state?.cursor ?? 0) || complete) {
            expect(row.applications).toBe(1);
            expect(row.transformed).toBe(row.source * 2);
          }
        }
        if (complete) {
          const differences = await client.unsafe(
            `(SELECT id, transformed FROM ${schema}.rows EXCEPT SELECT id, expected FROM ${schema}.oracle) UNION ALL (SELECT id, expected FROM ${schema}.oracle EXCEPT SELECT id, transformed FROM ${schema}.rows)`,
          );
          expect(differences).toHaveLength(0);
          const [sums] = await client.unsafe<
            { actual: string; oracle: string }[]
          >(
            `SELECT (SELECT sum(transformed)::text FROM ${schema}.rows) AS actual, (SELECT sum(expected)::text FROM ${schema}.oracle) AS oracle`,
          );
          expect(sums?.actual).toBe(sums?.oracle);
        }
        expect(records.length).toBeGreaterThan(0);
        for (const record of records) {
          expect(record).toMatchObject({
            config: { hardFloor: config.hardFloor },
            verdict: { signals: expect.any(Array) },
          });
        }
      };
      const run = async ({
        verdict = healthy,
        failHalfway = false,
        timeoutHalfway = false,
        killHalfway = false,
      } = {}) => {
        const runInTransaction: IngestionTransactionRunner<
          TransactionSQL
        > = async (transactionWork) => await client.begin(transactionWork);
        return await runAdaptiveBackfillBatch({
          config,
          clock: () => now,
          readVerdict: async () => verdict,
          slot: {
            tryAcquire: async (tx) =>
              await tryAcquireBackfillTransactionSlot({
                query: async (statement, parameters) =>
                  await tx.unsafe<{ acquired: boolean }[]>(statement, [
                    ...parameters,
                  ]),
              }),
            release: async () => {},
          },
          log: (record) => {
            records.push(record);
          },
          runInTransaction,
          readCheckpoint: async (tx) => {
            const state = (
              await tx.unsafe<StateRow[]>(
                `SELECT cursor, batch FROM ${schema}.checkpoint FOR UPDATE`,
              )
            ).at(0);
            if (state === undefined) {
              throw new TypeError("Fixture checkpoint missing");
            }
            return state;
          },
          persistCheckpoint: async (tx, state) => {
            await tx.unsafe(
              `UPDATE ${schema}.checkpoint SET cursor = $1, batch = $2::text::jsonb`,
              [state.cursor, JSON.stringify(state.batch)],
            );
          },
          selectPage: async (tx, cursor, size) => {
            const items = await tx.unsafe<FixtureRow[]>(
              `SELECT * FROM ${schema}.rows WHERE id > $1 ORDER BY id LIMIT $2 FOR UPDATE`,
              [cursor, size],
            );
            return {
              items,
              cursor: items.at(-1)?.id ?? cursor,
              done: items.length < size,
            };
          },
          needsWork: (row) => row.applications === 0,
          isStatementTimeout: (cause) =>
            isPgError(cause, PG_ERROR.QUERY_CANCELED),
          persistItems: async (tx, items) => {
            for (const [index, row] of items.entries()) {
              // db-await-in-loop: deterministic fault between row writes in one rollback boundary.
              await tx.unsafe(
                `UPDATE ${schema}.rows SET transformed = source * 2, applications = applications + 1 WHERE id = $1 AND applications = 0`,
                [row.id],
              );
              if (killHalfway && index === 1) {
                const backend = (
                  await tx.unsafe<{ pid: number }[]>(
                    "SELECT pg_backend_pid() AS pid",
                  )
                ).at(0);
                if (backend === undefined) {
                  throw new TypeError("Missing batch backend");
                }
                expect(
                  (
                    await writer.unsafe<{ killed: boolean }[]>(
                      "SELECT pg_terminate_backend($1, 5000) AS killed",
                      [backend.pid],
                    )
                  ).at(0)?.killed,
                ).toBe(true);
                await tx.unsafe("SELECT 1");
              }
              if (failHalfway && index === 1) {
                await tx.unsafe("SELECT 1 / 0");
              }
              if (timeoutHalfway && index === 1) {
                await tx.unsafe(
                  "DO $$ BEGIN RAISE EXCEPTION 'statement timeout injected' USING ERRCODE = '57014'; END $$",
                );
              }
            }
          },
        });
      };
      await work({
        run,
        client,
        writer,
        schema,
        invariant,
        restart: () => {
          client = openClient().sql;
        },
        advanceClock: (milliseconds) => {
          now += milliseconds;
        },
      });
      await invariant();
    } finally {
      await client.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    }
  });
};

describe.skipIf(!enabled)(
  "adaptive backfill real Postgres fault recovery",
  () => {
    test("a committed batch resumes twice without duplicate transformations", async () => {
      await withFixture(async ({ run, client, writer, invariant, restart }) => {
        await run();
        await invariant();
        const [{ pid } = { pid: 0 }] = await client.unsafe<{ pid: number }[]>(
          "SELECT pg_backend_pid() AS pid",
        );
        expect(pid).toBeGreaterThan(0);
        const killed = await writer.unsafe<{ killed: boolean }[]>(
          "SELECT pg_terminate_backend($1) AS killed",
          [pid],
        );
        expect(killed.at(0)?.killed).toBe(true);
        restart();
        // Discard all application cursor state after the commit; new invocations
        // read only the durable checkpoint, as a restarted process does.
        for (let batch = 0; batch < 5; batch++) {
          await run();
        }
        await invariant(true);
        await run();
        await run();
        await invariant(true);
      });
    });

    test("backend death inside the open batch rolls back and resumes twice", async () => {
      await withFixture(async ({ run, writer, schema, invariant, restart }) => {
        await expect(run({ killHalfway: true })).rejects.toThrow(
          /connection|closed|terminated|socket/iu,
        );
        expect(
          (
            await writer.unsafe<StateRow[]>(
              `SELECT cursor, batch FROM ${schema}.checkpoint`,
            )
          ).at(0)?.cursor,
        ).toBe(0);
        expect(
          await writer.unsafe(
            `SELECT id FROM ${schema}.rows WHERE applications <> 0`,
          ),
        ).toHaveLength(0);
        restart();
        await invariant();
        for (let batch = 0; batch < 5; batch++) {
          await run();
        }
        await invariant(true);
        restart();
        await run();
        await run();
        await invariant(true);
      });
    });

    test("a failure halfway rolls back both row counters and cursor", async () => {
      await withFixture(async ({ run, client, schema, invariant }) => {
        await expect(run({ failHalfway: true })).rejects.toThrow(
          "division by zero",
        );
        expect(
          (
            await client.unsafe<StateRow[]>(
              `SELECT cursor, batch FROM ${schema}.checkpoint`,
            )
          ).at(0)?.cursor,
        ).toBe(0);
        expect(
          (
            await client.unsafe<{ count: number }[]>(
              `SELECT count(*)::int AS count FROM ${schema}.rows WHERE applications <> 0`,
            )
          ).at(0)?.count,
        ).toBe(0);
        await invariant();
        for (let batch = 0; batch < 5; batch++) {
          await run();
        }
        await invariant(true);
      });
    });

    test("a hold preserves the committed cursor and resumes after its durable deadline", async () => {
      await withFixture(
        async ({ run, client, schema, invariant, advanceClock }) => {
          await run();
          const before = (
            await client.unsafe<StateRow[]>(
              `SELECT cursor, batch FROM ${schema}.checkpoint`,
            )
          ).at(0);
          await run({ verdict: { ...healthy, kind: "unknown" } });
          const after = (
            await client.unsafe<StateRow[]>(
              `SELECT cursor, batch FROM ${schema}.checkpoint`,
            )
          ).at(0);
          expect(after?.cursor).toBe(before?.cursor);
          expect(after?.batch.holdUntil).toBeGreaterThan(0);
          expect(after?.batch.size).toBe(before?.batch.size);
          await invariant();
          await run();
          expect(
            (
              await client.unsafe<StateRow[]>(
                `SELECT cursor, batch FROM ${schema}.checkpoint`,
              )
            ).at(0)?.cursor,
          ).toBe(before?.cursor);
          advanceClock(config.holdBackoffMs);
          for (let batch = 0; batch < 6; batch++) {
            await run();
          }
          await invariant(true);
        },
      );
    });

    test("a database timeout rolls back and reduces the retry size without skipping the range", async () => {
      await withFixture(async ({ run, client, schema, invariant }) => {
        const result = await run({ timeoutHalfway: true });
        expect(result).toMatchObject({
          status: "retry",
          checkpoint: { cursor: 0, batch: { size: 3 } },
        });
        expect(
          (
            await client.unsafe<{ count: number }[]>(
              `SELECT count(*)::int AS count FROM ${schema}.rows WHERE applications <> 0`,
            )
          ).at(0)?.count,
        ).toBe(0);
        await invariant();
        for (let batch = 0; batch < 8; batch++) {
          await run();
        }
        await invariant(true);
      });
    });

    test("concurrent application writes keep completed ranges equal to the oracle", async () => {
      await withFixture(async ({ run, writer, schema, invariant }) => {
        await run();
        await writer.unsafe(
          `INSERT INTO ${schema}.rows VALUES (0, 99, 198, 1), (20, 123, 246, 1)`,
        );
        await writer.unsafe(
          `INSERT INTO ${schema}.oracle VALUES (0, 198), (20, 246)`,
        );
        await Promise.all([
          run(),
          writer.begin(async (tx) => {
            await tx.unsafe(
              `UPDATE ${schema}.rows SET source = 101, transformed = 202, applications = 1 WHERE id IN (1, 6)`,
            );
            await tx.unsafe(
              `UPDATE ${schema}.oracle SET expected = 202 WHERE id IN (1, 6)`,
            );
          }),
        ]);
        for (let batch = 0; batch < 6; batch++) {
          await run();
        }
        await invariant(true);
      });
    });

    test("the production runtime persists holds, resumes and resets completed pass cursors", async () => {
      await withFixture(async ({ run, client, schema, invariant }) => {
        await run();
        await client.unsafe(`SET search_path TO ${schema}, public`);
        const migration = await Bun.file(
          new URL(
            "../../drizzle/20261001123000_database_backfill_state/migration.sql",
            import.meta.url,
          ),
        ).text();
        for (const statement of migration
          .replaceAll(
            "public.database_backfill_states",
            () => `${schema}.database_backfill_states`,
          )
          .split("--> statement-breakpoint")) {
          await client.unsafe(statement);
        }
        let now = Date.parse("2026-10-01T12:00:00.000Z");
        let verdict: Verdict = { ...healthy, kind: "unknown" };
        const records: unknown[] = [];
        const runtime = createBackfillRuntime({
          name: "runtime-replay",
          tableName: `${schema}.rows`,
          initialSize: 4,
          config,
          clock: () => now,
          readVerdict: async () => verdict,
          log: (record) => records.push(record),
          connection: {
            query: async (statement, parameters = []) =>
              await client.unsafe(statement, [...parameters]),
            execute: async (statement, parameters = []) => {
              await client.unsafe(statement, [...parameters]);
            },
            release: () => undefined,
          },
        });
        const step = async () =>
          await runtime.step(async ({ tx, cursor, size }) => {
            const rows = await tx.query(
              `SELECT id FROM ${schema}.rows WHERE id > $1 ORDER BY id LIMIT $2 FOR UPDATE`,
              [Number(cursor ?? 0), size],
            );
            const ids = rows.flatMap((row) =>
              typeof row === "object" &&
              row !== null &&
              "id" in row &&
              typeof row.id === "number"
                ? [row.id]
                : [],
            );
            await tx.execute(
              `UPDATE ${schema}.rows SET transformed = source * 2, applications = applications + 1 WHERE id = ANY(string_to_array($1, ',')::int[]) AND applications = 0`,
              [ids.join(",")],
            );
            return {
              cursor: ids.at(-1)?.toString() ?? cursor,
              done: ids.length < size,
              value: ids.length,
            };
          });
        try {
          await expect(step()).rejects.toThrow(BackfillHeldError);
          const held = (
            await client.unsafe<{ cursor: string | null; batch: BatchState }[]>(
              "SELECT cursor, batch FROM database_backfill_states",
            )
          ).at(0);
          expect(held?.cursor).toBeNull();
          expect(held?.batch.heldSince).toBe(now);
          verdict = healthy;
          await expect(step()).rejects.toThrow(BackfillHeldError);
          now += config.holdBackoffMs;
          let done = false;
          for (let batch = 0; batch < 8 && !done; batch++) {
            done = (await step()).done;
          }
          expect(done).toBe(true);
          const finished = (
            await client.unsafe<{ cursor: string | null }[]>(
              "SELECT cursor FROM database_backfill_states",
            )
          ).at(0);
          expect(finished?.cursor).toBeNull();
          await invariant(true);
          for (const record of records) {
            expect(record).toMatchObject({
              config: { hardFloor: config.hardFloor },
              verdict: { signals: expect.any(Array) },
            });
          }
        } finally {
          await runtime.close();
        }
      });
    });
  },
);
