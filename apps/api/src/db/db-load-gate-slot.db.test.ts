import type { ReservedSQL } from "bun";
import { describe, expect, test } from "bun:test";

import {
  createHeavyWorkSlot,
  tryAcquireBackfillTransactionSlot,
} from "../../../../packages/db-load-gate/src/heavy-work-slot";
import { withGatedTestClients } from "../tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const session = (connection: ReservedSQL) => ({
  query: async (query: string, parameters: readonly number[]) =>
    await connection.unsafe<{ acquired: boolean }[]>(query, [...parameters]),
});

describe.skipIf(!enabled || databaseUrl === undefined)(
  "database-wide heavy-work priorities",
  () => {
    for (const kind of ["transaction", "session"] as const) {
      test(`${kind} acquisition yields when index intent arrives after the precheck`, async () => {
        if (databaseUrl === undefined) {
          throw new TypeError("DATABASE_URL required");
        }
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const lowerConnection = await openClient().sql.reserve();
          const indexConnection = await openClient().sql.reserve();
          const index = createHeavyWorkSlot({
            session: session(indexConnection),
            kind: "index_build",
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
                expect(await index.tryAcquire()).toBe(false);
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
                : lower.tryAcquire()),
            ).toBe(false);
            expect(raced).toBe(true);
            if (kind === "transaction") {
              await lowerConnection`COMMIT`;
            }
            expect(await index.tryAcquire()).toBe(true);
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
          expect(await tryAcquireBackfillTransactionSlot(session(a))).toBe(
            true,
          );
          await b`BEGIN`;
          expect(await tryAcquireBackfillTransactionSlot(session(b))).toBe(
            false,
          );
          await b`COMMIT`;
          expect(await index.tryAcquire()).toBe(false);
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
          expect(await index.tryAcquire()).toBe(true);
          await a`COMMIT`;
          await b`COMMIT`;
          expect(await index.tryAcquire()).toBe(true);
          await index.close();
          await b`BEGIN`;
          expect(await tryAcquireBackfillTransactionSlot(session(b))).toBe(
            true,
          );
          await b`ROLLBACK`;
          await a`BEGIN`;
          expect(await tryAcquireBackfillTransactionSlot(session(a))).toBe(
            true,
          );
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
          Array.from(
            { length: 4 },
            async () => await openClient().sql.reserve(),
          ),
        );
        const [a, b, indexConnection, repairConnection] = connections;
        if (!a || !b || !indexConnection || !repairConnection) {
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
        const repair = createHeavyWorkSlot({
          session: session(repairConnection),
          kind: "index_repair",
        });
        try {
          expect(await backfill.tryAcquire()).toBe(true);
          expect(await backfill.tryAcquire()).toBe(true);
          expect(await other.tryAcquire()).toBe(false);
          expect(await index.tryAcquire()).toBe(false);
          expect(await repair.tryAcquire()).toBe(false);
          await backfill.release();
          expect(await backfill.tryAcquire()).toBe(false);
          expect(await other.tryAcquire()).toBe(false);
          expect(await index.tryAcquire()).toBe(false);
          expect(await repair.tryAcquire()).toBe(true);
          await repair.close();
          await repair.close();
          expect(await other.tryAcquire()).toBe(false);
          expect(await index.tryAcquire()).toBe(true);
          await index.close();
          expect(await other.tryAcquire()).toBe(true);
          await other.release();
          expect(await backfill.tryAcquire()).toBe(true);
        } finally {
          await backfill.close();
          await other.close();
          await index.close();
          await repair.close();
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
            expect(await holder.tryAcquire()).toBe(true);
            expect(await next.tryAcquire()).toBe(false);
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
            expect(await next.tryAcquire()).toBe(true);
          } finally {
            await next.close();
            killed.release();
            survivor.release();
          }
        },
        { closeTimeout: 0 },
      );
    });
  },
);
