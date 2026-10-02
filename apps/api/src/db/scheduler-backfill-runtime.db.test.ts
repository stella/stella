import { panic, Result } from "better-result";
import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";

import {
  type backfillHeartbeat,
  combine,
  type BatchState,
} from "@stll/db-load-gate/health";
import { ebsBalance } from "@stll/db-load-gate/indicators";
import { createHeavyWorkSlot } from "@stll/db-load-gate/slot";

import {
  SCHEDULER_BACKFILL_CONFIG,
  SCHEDULER_BACKFILL_IDS,
} from "../lib/scheduler/backfill-config";
import { isRecord } from "../lib/type-guards";
import { withGatedTestClients } from "../tests/gated-test-database";
import { BackfillHeldError, createBackfillRuntime } from "./backfill-runtime";
import type { OnlineMigrationConnection } from "./online-migration-connection";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const config = {
  ...SCHEDULER_BACKFILL_CONFIG,
  minSize: 1,
  maxSize: 4,
  minSleepMs: 0,
  maxSleepMs: 0,
  busyWindows: [],
};
const NAME = SCHEDULER_BACKFILL_IDS.provisionState;

type BatchOptions = {
  tx: Pick<OnlineMigrationConnection, "execute" | "query">;
  cursor: string | null;
  size: number;
};

const withFixture = async (
  work: (fixture: {
    client: SQL;
    operatorClient: SQL;
    schema: string;
    records: ReturnType<typeof backfillHeartbeat>[];
    balance: (value: number) => void;
    advance: (milliseconds: number) => void;
    checkpoint: () => Promise<{ cursor: string | null; batch: BatchState }>;
    openRuntime: () => Promise<{
      runtime: ReturnType<typeof createBackfillRuntime>;
      session: Awaited<ReturnType<SQL["reserve"]>>;
      close: () => Promise<void>;
      markKilled: () => void;
    }>;
    batch: (
      options: BatchOptions,
    ) => Promise<{ cursor: string | null; done: boolean; value: number[] }>;
  }) => Promise<void>,
) => {
  if (databaseUrl === undefined) {
    panic("DATABASE_URL required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const client = openClient().sql;
    const operatorClient = openClient().sql;
    const schema = `scheduler_backfill_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    const closers: (() => Promise<void>)[] = [];
    const records: ReturnType<typeof backfillHeartbeat>[] = [];
    let now = Date.parse("2026-10-02T12:00:00Z");
    let balance = 80;
    await client.unsafe(`CREATE SCHEMA ${schema}`);
    try {
      const version = (
        await client.unsafe<{ version: number }[]>(
          "SELECT current_setting('server_version_num')::int AS version",
        )
      ).at(0)?.version;
      expect(version).toBeGreaterThanOrEqual(180_000);
      expect(version).toBeLessThan(190_000);
      await client.unsafe(
        `CREATE TABLE ${schema}.database_backfill_states (LIKE public.database_backfill_states INCLUDING ALL)`,
      );
      await client.unsafe(
        `CREATE TABLE ${schema}.rows (id int PRIMARY KEY, applications int NOT NULL DEFAULT 0)`,
      );
      await client.unsafe(
        `INSERT INTO ${schema}.rows (id) SELECT generate_series(1, 8)`,
      );
      const checkpoint = async () => {
        const row = (
          await client.unsafe<{ cursor: string | null; batch: BatchState }[]>(
            `SELECT cursor, batch FROM ${schema}.database_backfill_states WHERE name = $1`,
            [NAME],
          )
        ).at(0);
        if (row === undefined) {
          return panic("Missing durable test checkpoint");
        }
        return row;
      };
      const openRuntime = async () => {
        const session = await openClient().sql.reserve();
        await session.unsafe(`SET search_path TO ${schema}, public`);
        const runtime = createBackfillRuntime({
          connection: {
            execute: async (statement, parameters = []) => {
              await session.unsafe(statement, [...parameters]);
            },
            query: async (statement, parameters = []) =>
              await session.unsafe<unknown[]>(statement, [...parameters]),
          },
          name: NAME,
          tableName: `${schema}.rows`,
          initialSize: 4,
          initialCursor: "0",
          config,
          clock: () => now,
          readVerdict: async () =>
            combine([
              await ebsBalance({
                config,
                now: () => now,
                read: async () => ({
                  byteBalancePct: balance,
                  ioBalancePct: balance,
                  observedAt: new Date(now).toISOString(),
                }),
              }),
            ]),
          observeStatus: (record) => {
            records.push(record);
          },
          log: () => {},
        });
        let state: "live" | "killed" | "closed" = "live";
        const close = async () => {
          if (state === "closed") {
            return;
          }
          try {
            if (state === "live") {
              await runtime.close();
            }
          } finally {
            state = "closed";
            session.release();
          }
        };
        closers.push(close);
        return {
          runtime,
          session,
          close,
          markKilled: () => {
            state = "killed";
          },
        };
      };
      const batch = async ({ tx, cursor, size }: BatchOptions) => {
        const rows = await tx.query(
          `SELECT id FROM rows WHERE id > $1::int ORDER BY id LIMIT $2 FOR UPDATE`,
          [cursor ?? "0", size],
        );
        const ids = rows.map((row) => {
          if (!isRecord(row) || typeof row["id"] !== "number") {
            return panic("Invalid test row");
          }
          return row["id"];
        });
        const last = ids.at(-1);
        if (last !== undefined) {
          await tx.execute(
            "UPDATE rows SET applications = applications + 1 WHERE id > $1::int AND id <= $2 AND applications = 0",
            [cursor ?? "0", last],
          );
        }
        now += 10;
        return {
          cursor: last === undefined ? cursor : String(last),
          done: rows.length === 0,
          value: ids,
        };
      };
      await work({
        client,
        operatorClient,
        schema,
        records,
        balance: (value) => {
          balance = value;
        },
        advance: (milliseconds) => {
          now += milliseconds;
        },
        checkpoint,
        openRuntime,
        batch,
      });
    } finally {
      try {
        for (const close of closers) {
          // db-await-in-loop: release reserved physical sessions before dropping their schema.
          await close();
        }
      } finally {
        await client.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      }
    }
  });
};

describe.skipIf(!enabled)(
  "raw scheduler backfill runtime on PostgreSQL 18",
  () => {
    test("64 holds durably across restart, 74 stays held, and 75 resumes the exact cursor", async () => {
      await withFixture(
        async ({
          balance,
          advance,
          checkpoint,
          openRuntime,
          batch,
          records,
        }) => {
          const first = await openRuntime();
          expect((await first.runtime.step(batch)).cursor).toBe("4");
          balance(64);
          await expect(first.runtime.step(batch)).rejects.toBeInstanceOf(
            BackfillHeldError,
          );
          const held = await checkpoint();
          expect(held.cursor).toBe("4");
          expect(held.batch.heldSince).not.toBeNull();
          expect(held.batch.holdUntil).toBeGreaterThan(
            held.batch.heldSince ?? 0,
          );
          await first.close();
          const restarted = await openRuntime();
          advance(config.holdBackoffCapMs + 1);
          balance(74);
          await expect(restarted.runtime.step(batch)).rejects.toBeInstanceOf(
            BackfillHeldError,
          );
          expect((await checkpoint()).batch.heldSince).toBe(
            held.batch.heldSince,
          );
          expect((await checkpoint()).cursor).toBe("4");
          advance(config.holdBackoffCapMs + 1);
          balance(75);
          const resumed = await restarted.runtime.step(batch);
          expect(resumed.value.at(0)).toBe(5);
          expect((await checkpoint()).cursor).toBe(resumed.cursor);
          expect((await checkpoint()).batch.heldSince).toBeNull();
          await restarted.close();
          expect(records.map(({ BackfillYielded }) => BackfillYielded)).toEqual(
            [1, 0],
          );
        },
      );
    });

    test("operator intent arriving during a running transaction wins the next batch", async () => {
      await withFixture(
        async ({ operatorClient, advance, openRuntime, batch, checkpoint }) => {
          const backfill = await openRuntime();
          const operatorSession = await operatorClient.reserve();
          const operator = createHeavyWorkSlot({
            kind: "operator_job",
            session: {
              query: async (statement, parameters) =>
                await operatorSession.unsafe<{ acquired: boolean }[]>(
                  statement,
                  [...parameters],
                ),
            },
          });
          try {
            await backfill.runtime.step(async (options) => {
              const written = await batch(options);
              const acquisition = await operator.tryAcquire();
              expect(acquisition.isOk()).toBe(true);
              if (acquisition.isErr()) {
                throw acquisition.error;
              }
              expect(acquisition.value).toBe(false);
              return written;
            });
            expect((await checkpoint()).cursor).toBe("4");
            await expect(backfill.runtime.step(batch)).rejects.toBeInstanceOf(
              BackfillHeldError,
            );
            expect((await checkpoint()).cursor).toBe("4");
            expect((await checkpoint()).batch.heldSince).not.toBeNull();
            await operator.close();
            advance(config.holdBackoffCapMs + 1);
            expect((await backfill.runtime.step(batch)).value.at(0)).toBe(5);
            expect((await checkpoint()).batch.heldSince).toBeNull();
          } finally {
            await operator.close();
            operatorSession.release();
          }
        },
      );
    });

    test("backend death rolls back writes and cursor, then restart applies every row once", async () => {
      await withFixture(
        async ({ client, schema, openRuntime, batch, checkpoint }) => {
          const first = await openRuntime();
          expect((await first.runtime.step(batch)).cursor).toBe("4");
          const killed = await Result.tryPromise(
            async () =>
              await first.runtime.step(async (options) => {
                const written = await batch(options);
                expect(written.value).toEqual([5, 6, 7, 8]);
                const backend = (
                  await first.session.unsafe<{ pid: number }[]>(
                    "SELECT pg_backend_pid() AS pid",
                  )
                ).at(0);
                if (backend === undefined) {
                  return panic("Missing test backend pid");
                }
                const terminated = (
                  await client.unsafe<{ killed: boolean }[]>(
                    "SELECT pg_terminate_backend($1, 5000) AS killed",
                    [backend.pid],
                  )
                ).at(0)?.killed;
                expect(terminated).toBe(true);
                first.markKilled();
                await options.tx.execute("SELECT 1");
                return written;
              }),
          );
          expect(killed.isErr()).toBe(true);
          if (killed.isOk()) {
            return panic("Killed backfill transaction succeeded");
          }
          expect(String(killed.error)).toMatch(
            /closed|terminated|connection|socket/iu,
          );
          await first.close();
          expect((await checkpoint()).cursor).toBe("4");
          expect(
            await client.unsafe<{ id: number; applications: number }[]>(
              `SELECT id, applications FROM ${schema}.rows WHERE id > 4 ORDER BY id`,
            ),
          ).toEqual([5, 6, 7, 8].map((id) => ({ id, applications: 0 })));
          const restarted = await openRuntime();
          expect((await restarted.runtime.step(batch)).value).toEqual([
            5, 6, 7, 8,
          ]);
          expect((await checkpoint()).cursor).toBe("8");
          expect((await restarted.runtime.step(batch)).done).toBe(true);
          expect((await checkpoint()).cursor).toBeNull();
          expect(
            await client.unsafe<{ id: number; applications: number }[]>(
              `SELECT id, applications FROM ${schema}.rows ORDER BY id`,
            ),
          ).toEqual(
            Array.from({ length: 8 }, (_, index) => ({
              id: index + 1,
              applications: 1,
            })),
          );
        },
      );
    });
    test("concurrent completion confirms under the checkpoint lock and both workers converge", async () => {
      await withFixture(async ({ balance, checkpoint, openRuntime }) => {
        const first = await openRuntime();
        const second = await openRuntime();
        balance(64);
        await expect(
          first.runtime.step(async () =>
            panic("Held runtime must not execute work"),
          ),
        ).rejects.toBeInstanceOf(BackfillHeldError);
        const held = await checkpoint();
        const entered = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        let confirmations = 0;
        const completing = first.runtime.recordCompletion(async () => {
          entered.resolve(undefined);
          await release.promise;
          return true;
        });
        await entered.promise;
        try {
          // The first worker pauses while holding the checkpoint row. The
          // second must time out on that row, before it can confirm completion.
          const concurrent = await Result.tryPromise(
            async () =>
              await second.runtime.recordCompletion(async () => {
                confirmations += 1;
                return true;
              }),
          );
          expect(concurrent.isErr()).toBe(true);
          if (concurrent.isOk()) {
            return panic("Concurrent completion bypassed the checkpoint lock");
          }
          expect(String(concurrent.error)).toMatch(/lock timeout/iu);
          expect(confirmations).toBe(0);
          expect(await checkpoint()).toEqual(held);
        } finally {
          release.resolve(undefined);
          await completing;
        }
        await second.runtime.recordCompletion(async () => {
          confirmations += 1;
          return true;
        });
        expect(confirmations).toBe(1);
        expect((await checkpoint()).cursor).toBeNull();
        expect((await checkpoint()).batch.heldSince).toBeNull();
        expect((await checkpoint()).batch.holdUntil).toBeNull();
      });
    });

    test("backend death after the last committed batch preserves progress for restart completion", async () => {
      await withFixture(
        async ({ client, schema, checkpoint, openRuntime, batch }) => {
          const first = await openRuntime();
          await first.runtime.step(batch);
          await first.runtime.step(batch);
          expect((await checkpoint()).cursor).toBe("8");
          const backend = (
            await first.session.unsafe<{ pid: number }[]>(
              "SELECT pg_backend_pid() AS pid",
            )
          ).at(0);
          if (backend === undefined) {
            return panic("Missing test backend pid");
          }
          expect(
            (
              await client.unsafe<{ killed: boolean }[]>(
                "SELECT pg_terminate_backend($1, 5000) AS killed",
                [backend.pid],
              )
            ).at(0)?.killed,
          ).toBe(true);
          first.markKilled();
          const completion = await Result.tryPromise(
            async () => await first.runtime.recordCompletion(async () => true),
          );
          expect(completion.isErr()).toBe(true);
          if (completion.isOk()) {
            return panic("Killed runtime recorded completion");
          }
          expect(String(completion.error)).toMatch(
            /closed|terminated|connection|socket/iu,
          );
          expect((await checkpoint()).cursor).toBe("8");
          await first.close();
          const restarted = await openRuntime();
          await restarted.runtime.recordCompletion(async (tx) => {
            const rows = await tx.query(
              "SELECT id FROM rows WHERE applications = 0 LIMIT 1",
            );
            return rows.length === 0;
          });
          expect((await checkpoint()).cursor).toBeNull();
          expect((await checkpoint()).batch.heldSince).toBeNull();
          expect(
            await client.unsafe<{ id: number; applications: number }[]>(
              `SELECT id, applications FROM ${schema}.rows ORDER BY id`,
            ),
          ).toEqual(
            Array.from({ length: 8 }, (_, index) => ({
              id: index + 1,
              applications: 1,
            })),
          );
        },
      );
    });

    test("a worker confirming completed work clears a hold left by another worker", async () => {
      await withFixture(async ({ balance, checkpoint, openRuntime }) => {
        const completing = await openRuntime();
        const holding = await openRuntime();
        balance(64);
        await expect(
          holding.runtime.step(async () =>
            panic("Held runtime must not execute work"),
          ),
        ).rejects.toBeInstanceOf(BackfillHeldError);
        const held = await checkpoint();
        expect(held.batch.heldSince).not.toBeNull();
        await completing.runtime.recordCompletion(async () => false);
        expect(await checkpoint()).toEqual(held);
        await completing.runtime.recordCompletion(async () => true);
        expect((await checkpoint()).batch.heldSince).toBeNull();
      });
    });
  },
);
