import type { ReservedSQL } from "bun";
import { describe, expect, test } from "bun:test";

import {
  createHeavyWorkSlot,
  tryAcquireBackfillTransactionSlot,
} from "../../../../packages/db-load-gate/src/heavy-work-slot";
import { withGatedTestClients } from "../tests/gated-test-database";

const OLD_BACKFILL_INTENT_KEY = 3;
const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const session = (connection: ReservedSQL) => ({
  query: async (query: string, parameters: readonly number[]) =>
    await connection.unsafe<{ acquired: boolean }[]>(query, [...parameters]),
});

describe.skipIf(!enabled)("database-wide heavy-work priorities", () => {
  for (const priority of [
    "index_repair",
    "index_build",
    "operator_job",
  ] as const) {
    for (const kind of ["transaction", "session"] as const) {
      test(`${kind} acquisition yields when ${priority} intent arrives after the precheck`, async () => {
        if (databaseUrl === undefined) {
          throw new TypeError("DATABASE_URL required");
        }
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const lowerConnection = await openClient().sql.reserve();
          const indexConnection = await openClient().sql.reserve();
          const index = createHeavyWorkSlot({
            session: session(indexConnection),
            kind: priority,
          });
          let raced = false;
          const barrierSession = {
            query: async (statement: string, parameters: readonly number[]) => {
              const result = await session(lowerConnection).query(
                statement,
                parameters,
              );
              if (
                statement.includes("pg_try_advisory") &&
                !statement.includes("shared")
              ) {
                expect(result.at(0)?.acquired).toBe(true);
                expect((await index.tryAcquire()).unwrap()).toBe(false);
                raced = true;
              }
              return result;
            },
          };
          const lower = createHeavyWorkSlot({
            session: barrierSession,
            kind: "backfill_batch",
          });
          try {
            if (kind === "transaction") {
              await lowerConnection`BEGIN`;
            }
            expect(
              await (kind === "transaction"
                ? tryAcquireBackfillTransactionSlot(barrierSession)
                : lower.tryAcquire().then((result) => result.unwrap())),
            ).toBe(false);
            expect(raced).toBe(true);
            if (kind === "transaction") {
              await lowerConnection`COMMIT`;
            }
            expect((await index.tryAcquire()).unwrap()).toBe(true);
          } finally {
            await lowerConnection`ROLLBACK`;
            await lower.close();
            await index.close();
            lowerConnection.release();
            indexConnection.release();
          }
        });
      });
    }
  }
  test("an operator yields to index intent arriving after its priority precheck", async () => {
    if (databaseUrl === undefined) {
      throw new TypeError("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const operatorConnection = await openClient().sql.reserve();
      const indexConnection = await openClient().sql.reserve();
      const index = createHeavyWorkSlot({
        session: session(indexConnection),
        kind: "index_build",
      });
      let raced = false;
      const operator = createHeavyWorkSlot({
        kind: "operator_job",
        session: {
          query: async (statement, parameters) => {
            const result = await session(operatorConnection).query(
              statement,
              parameters,
            );
            if (!raced && statement.includes("pg_try_advisory_lock(")) {
              expect(result.at(0)?.acquired).toBe(true);
              expect((await index.tryAcquire()).unwrap()).toBe(false);
              raced = true;
            }
            return result;
          },
        },
      });
      try {
        expect((await operator.tryAcquire()).unwrap()).toBe(false);
        expect(raced).toBe(true);
        expect((await index.tryAcquire()).unwrap()).toBe(true);
        await index.close();
        expect((await operator.tryAcquire()).unwrap()).toBe(true);
      } finally {
        await operator.close();
        await index.close();
        operatorConnection.release();
        indexConnection.release();
      }
    });
  });

  test("queued operators ignore peer compatibility aliases and serialize work", async () => {
    if (databaseUrl === undefined) {
      throw new TypeError("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const backfillConnection = await openClient().sql.reserve();
      const firstConnection = await openClient().sql.reserve();
      const secondConnection = await openClient().sql.reserve();
      const backfill = createHeavyWorkSlot({
        session: session(backfillConnection),
        kind: "backfill_batch",
      });
      const first = createHeavyWorkSlot({
        session: session(firstConnection),
        kind: "operator_job",
      });
      const second = createHeavyWorkSlot({
        session: session(secondConnection),
        kind: "operator_job",
      });
      try {
        expect((await backfill.tryAcquire()).unwrap()).toBe(true);
        expect((await first.tryAcquire()).unwrap()).toBe(false);
        expect((await second.tryAcquire()).unwrap()).toBe(false);
        // Exercise the pre-operator process's actual priority predicate.
        const oldProbe = await backfillConnection.unsafe<
          { acquired: boolean }[]
        >(
          `
          SELECT NOT EXISTS (
            SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory' AND granted AND mode = 'ShareLock'
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
              AND classid = $1::oid AND objid > 0 AND objid < $2::oid AND objsubid = 2
          ) AS acquired`,
          [1_937_007_724, OLD_BACKFILL_INTENT_KEY],
        );
        expect(oldProbe.at(0)?.acquired).toBe(false);
        await backfill.release();
        expect((await first.tryAcquire()).unwrap()).toBe(true);
        expect((await second.tryAcquire()).unwrap()).toBe(false);
        await first.release();
        expect((await second.tryAcquire()).unwrap()).toBe(true);
        expect((await first.tryAcquire()).unwrap()).toBe(false);
        await second.close();
        expect((await first.tryAcquire()).unwrap()).toBe(true);
      } finally {
        await backfill.close();
        await first.close();
        await second.close();
        backfillConnection.release();
        firstConnection.release();
        secondConnection.release();
      }
    });
  });

  test("transactional batches serialize and yield to an index at their next commit", async () => {
    if (databaseUrl === undefined) {
      throw new TypeError("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const a = await openClient().sql.reserve();
      const b = await openClient().sql.reserve();
      const c = await openClient().sql.reserve();
      const index = createHeavyWorkSlot({
        session: session(c),
        kind: "index_build",
      });
      try {
        await a`BEGIN`;
        expect(await tryAcquireBackfillTransactionSlot(session(a))).toBe(true);
        await b`BEGIN`;
        expect(await tryAcquireBackfillTransactionSlot(session(b))).toBe(false);
        await b`COMMIT`;
        expect((await index.tryAcquire()).unwrap()).toBe(false);
        await a`COMMIT`;
        // Even concurrent batch attempts cannot prevent shared intent registration.
        await a`BEGIN`;
        await b`BEGIN`;
        expect(
          await Promise.all([
            tryAcquireBackfillTransactionSlot(session(a)),
            tryAcquireBackfillTransactionSlot(session(b)),
          ]),
        ).toEqual([false, false]);
        expect((await index.tryAcquire()).unwrap()).toBe(true);
        await a`COMMIT`;
        await b`COMMIT`;
        expect((await index.tryAcquire()).unwrap()).toBe(true);
        await index.close();
        await b`BEGIN`;
        expect(await tryAcquireBackfillTransactionSlot(session(b))).toBe(true);
        await b`ROLLBACK`;
        await a`BEGIN`;
        expect(await tryAcquireBackfillTransactionSlot(session(a))).toBe(true);
        await a`COMMIT`;
      } finally {
        await a`ROLLBACK`;
        await b`ROLLBACK`;
        await index.close();
        a.release();
        b.release();
        c.release();
      }
    });
  });
  test("backfills serialize and a waiting index and repair prevent lower priority reacquisition", async () => {
    if (databaseUrl === undefined) {
      throw new TypeError("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const connections = await Promise.all(
        Array.from({ length: 5 }, async () => await openClient().sql.reserve()),
      );
      const [a, b, indexConnection, repairConnection, operatorConnection] =
        connections;
      if (
        !a ||
        !b ||
        !indexConnection ||
        !repairConnection ||
        !operatorConnection
      ) {
        throw new TypeError("Missing connection");
      }
      const backfill = createHeavyWorkSlot({
        session: session(a),
        kind: "backfill_batch",
      });
      const other = createHeavyWorkSlot({
        session: session(b),
        kind: "backfill_batch",
      });
      const index = createHeavyWorkSlot({
        session: session(indexConnection),
        kind: "index_build",
      });
      const operator = createHeavyWorkSlot({
        session: session(operatorConnection),
        kind: "operator_job",
      });
      const repair = createHeavyWorkSlot({
        session: session(repairConnection),
        kind: "index_repair",
      });
      try {
        expect((await backfill.tryAcquire()).unwrap()).toBe(true);
        expect((await backfill.tryAcquire()).unwrap()).toBe(true);
        expect((await other.tryAcquire()).unwrap()).toBe(false);
        expect((await operator.tryAcquire()).unwrap()).toBe(false);
        expect((await index.tryAcquire()).unwrap()).toBe(false);
        expect((await repair.tryAcquire()).unwrap()).toBe(false);
        await backfill.release();
        expect((await backfill.tryAcquire()).unwrap()).toBe(false);
        expect((await other.tryAcquire()).unwrap()).toBe(false);
        expect((await index.tryAcquire()).unwrap()).toBe(false);
        expect((await repair.tryAcquire()).unwrap()).toBe(true);
        await repair.close();
        await repair.close();
        expect((await other.tryAcquire()).unwrap()).toBe(false);
        expect((await operator.tryAcquire()).unwrap()).toBe(false);
        expect((await index.tryAcquire()).unwrap()).toBe(true);
        await index.close();
        expect((await other.tryAcquire()).unwrap()).toBe(false);
        expect((await operator.tryAcquire()).unwrap()).toBe(true);
        await operator.close();
        expect((await other.tryAcquire()).unwrap()).toBe(true);
        await other.release();
        expect((await backfill.tryAcquire()).unwrap()).toBe(true);
      } finally {
        await backfill.close();
        await other.close();
        await index.close();
        await repair.close();
        await operator.close();
        for (const connection of connections) {
          connection.release();
        }
      }
    });
  });

  test("a terminated holder frees both work and priority intent", async () => {
    if (databaseUrl === undefined) {
      throw new TypeError("DATABASE_URL required");
    }
    await withGatedTestClients(
      databaseUrl,
      async ({ openClient }) => {
        const killed = await openClient().sql.reserve();
        const survivor = await openClient().sql.reserve();
        const admin = openClient().sql;
        const holder = createHeavyWorkSlot({
          session: session(killed),
          kind: "index_repair",
        });
        const next = createHeavyWorkSlot({
          session: session(survivor),
          kind: "backfill_batch",
        });
        try {
          expect((await holder.tryAcquire()).unwrap()).toBe(true);
          expect((await next.tryAcquire()).unwrap()).toBe(false);
          const rows = await killed<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          const pid = rows.at(0)?.pid;
          if (pid === undefined) {
            throw new TypeError("Missing backend pid");
          }
          // Termination completes asynchronously; closing the client confirms its
          // backend session ended, without sleeps or repeated observations.
          await admin`SELECT pg_terminate_backend(${pid}, 5000)`;
          expect((await next.tryAcquire()).unwrap()).toBe(true);
        } finally {
          await next.close();
          killed.release();
          survivor.release();
        }
      },
      { closeTimeout: 0 },
    );
  });
});

describe.skipIf(!enabled)("operator compatibility alias correlation", () => {
  test("a real index intent keeps precedence while two operators register aliases", async () => {
    if (databaseUrl === undefined) {
      throw new TypeError("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const connections = await Promise.all(
        Array.from({ length: 4 }, async () => await openClient().sql.reserve()),
      );
      const [
        backfillConnection,
        firstConnection,
        secondConnection,
        indexConnection,
      ] = connections;
      if (
        !backfillConnection ||
        !firstConnection ||
        !secondConnection ||
        !indexConnection
      ) {
        throw new TypeError("Missing test connection");
      }
      const backfill = createHeavyWorkSlot({
        session: session(backfillConnection),
        kind: "backfill_batch",
      });
      const first = createHeavyWorkSlot({
        session: session(firstConnection),
        kind: "operator_job",
      });
      const second = createHeavyWorkSlot({
        session: session(secondConnection),
        kind: "operator_job",
      });
      const index = createHeavyWorkSlot({
        session: session(indexConnection),
        kind: "index_build",
      });
      try {
        expect((await backfill.tryAcquire()).unwrap()).toBe(true);
        expect((await first.tryAcquire()).unwrap()).toBe(false);
        expect((await second.tryAcquire()).unwrap()).toBe(false);
        expect((await index.tryAcquire()).unwrap()).toBe(false);
        await backfill.release();
        // Only a key-2 intent on the SAME backend as key 4 is an alias.
        expect((await first.tryAcquire()).unwrap()).toBe(false);
        expect((await second.tryAcquire()).unwrap()).toBe(false);
        expect((await index.tryAcquire()).unwrap()).toBe(true);
        await index.close();
        expect((await first.tryAcquire()).unwrap()).toBe(true);
        expect((await second.tryAcquire()).unwrap()).toBe(false);
        await first.release();
        expect((await second.tryAcquire()).unwrap()).toBe(true);
      } finally {
        await backfill.close();
        await first.close();
        await second.close();
        await index.close();
        for (const connection of connections) {
          connection.release();
        }
      }
    });
  });
});
