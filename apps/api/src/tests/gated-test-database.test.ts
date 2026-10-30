import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import { withTimeout } from "@stll/concurrency/with-timeout";
import { rejectionOf } from "@stll/property-testing/rejection";

import { forceClosePool, terminateReserved } from "@/api/db/sql-close";
import {
  currentQueryCount,
  currentTransactionCount,
  runWithQueryCounter,
} from "@/api/lib/db-query-counter";
import { PG_DRIVER_ERROR } from "@/api/lib/pg-error";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";
import { HAPPY_PATH_TIMEOUT_MS } from "@/api/tests/test-timeouts";

import { withGatedTestClients } from "./gated-test-database";

const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const sessionSchema = v.object({ pid: v.number() });

describe.skipIf(!runPostgresTests)("gated database instrumentation", () => {
  test("counts Bun transaction start and settle round trips beside SQL statements", async () => {
    const databaseUrl = v.parse(v.string(), process.env["DATABASE_URL"]);
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const result = await runWithQueryCounter(
        async () => {
          await db.transaction(async (tx) => {
            await tx.execute(sql`select 1`);
          });
          return {
            statements: currentQueryCount(),
            transactionRoundTrips: currentTransactionCount(),
          };
        },
        { countTransactions: true },
      );
      expect(result).toEqual({ statements: 1, transactionRoundTrips: 2 });

      const rollbackRoundTrips = await runWithQueryCounter(
        async () => {
          expect(
            await rejectionOf(
              db.transaction(async () => {
                throw new Error("rollback this transaction");
              }),
            ),
          ).toMatchObject({ message: "rollback this transaction" });
          return currentTransactionCount();
        },
        { countTransactions: true },
      );
      expect(rollbackRoundTrips).toBe(2);
    });
  });
});

describe.skipIf(!runPostgresTests)("forced PostgreSQL scope cleanup", () => {
  test("terminates an observed lock wait while the blocking session still holds its lock", async () => {
    const databaseUrl = v.parse(v.string(), process.env["DATABASE_URL"]);
    await withGatedTestClients(
      databaseUrl,
      async ({ openClient }) => {
        const holder = openClient().sql;
        const observer = openClient().sql;
        const { pid: holdingPid } = v.parse(
          sessionSchema,
          (await holder`SELECT pg_backend_pid() AS pid`).at(0),
        );
        let blockedClient: SQL | undefined;
        try {
          const result = await withTimeout(
            async () =>
              await withGatedTestClients(
                databaseUrl,
                async ({ openClient: openBlockedClient }) => {
                  const client = openBlockedClient().sql;
                  blockedClient = client;
                  const { pid: waitingPid } = v.parse(
                    sessionSchema,
                    (await client`SELECT pg_backend_pid() AS pid`).at(0),
                  );
                  await holder`SELECT pg_advisory_lock(${holdingPid}, ${waitingPid})`;
                  const query =
                    client`SELECT pg_advisory_lock(${holdingPid}, ${waitingPid})`.then(
                      () => ({ status: "fulfilled" }) as const,
                      (error: unknown) =>
                        ({ status: "rejected", error }) as const,
                    );
                  await waitForBlockedPid(observer, { waitingPid, holdingPid });
                  return { query, waitingPid };
                },
                { closeMode: "force" },
              ),
            { label: "blocked PostgreSQL scope cleanup", timeoutMs: 5000 },
          );
          expect(
            await withTimeout(async () => await result.query, {
              label: "closed PostgreSQL query rejection",
              timeoutMs: HAPPY_PATH_TIMEOUT_MS,
            }),
          ).toMatchObject({
            status: "rejected",
            error: { code: PG_DRIVER_ERROR.CONNECTION_CLOSED },
          });
          expect(
            v.parse(
              v.object({ held: v.boolean() }),
              (
                await holder`SELECT pg_advisory_unlock(${holdingPid}, ${result.waitingPid}) AS held`
              ).at(0),
            ).held,
          ).toBe(true);
        } finally {
          // Release first so even a draining-close mutation cannot stall test cleanup.
          await holder`SELECT pg_advisory_unlock_all()`;
          if (blockedClient !== undefined) {
            await forceClosePool(blockedClient);
          }
        }
      },
      { closeMode: "force" },
    );
  }, 10_000);

  test("reserved termination ends an observed lock wait without the positive-timeout path", async () => {
    const databaseUrl = v.parse(v.string(), process.env["DATABASE_URL"]);
    await withGatedTestClients(
      databaseUrl,
      async ({ openClient }) => {
        const holder = openClient().sql;
        const observer = openClient().sql;
        const pool = openClient().sql;
        const reserved = await pool.reserve();
        const { pid: holdingPid } = v.parse(
          sessionSchema,
          (await holder`SELECT pg_backend_pid() AS pid`).at(0),
        );
        const { pid: waitingPid } = v.parse(
          sessionSchema,
          (await reserved`SELECT pg_backend_pid() AS pid`).at(0),
        );
        try {
          await holder`SELECT pg_advisory_lock(${holdingPid}, ${waitingPid})`;
          const query = reserved
            .unsafe("SELECT pg_advisory_lock($1, $2)", [holdingPid, waitingPid])
            .then(
              () => ({ status: "fulfilled" }) as const,
              (error: unknown) => ({ status: "rejected", error }) as const,
            );
          await waitForBlockedPid(observer, { waitingPid, holdingPid });
          await withTimeout(async () => await terminateReserved(reserved), {
            label: "reserved PostgreSQL termination",
            timeoutMs: HAPPY_PATH_TIMEOUT_MS,
          });
          expect(
            await withTimeout(async () => await query, {
              label: "terminated reserved query rejection",
              timeoutMs: HAPPY_PATH_TIMEOUT_MS,
            }),
          ).toMatchObject({
            status: "rejected",
            error: { code: PG_DRIVER_ERROR.CONNECTION_CLOSED },
          });
          expect(
            v.parse(
              v.object({ held: v.boolean() }),
              (
                await holder`SELECT pg_advisory_unlock(${holdingPid}, ${waitingPid}) AS held`
              ).at(0),
            ).held,
          ).toBe(true);
        } finally {
          // Release the waiter even when a mutation makes termination drain queries.
          await holder`SELECT pg_advisory_unlock_all()`;
          await forceClosePool(pool);
        }
      },
      { closeMode: "force" },
    );
  }, 10_000);
});
