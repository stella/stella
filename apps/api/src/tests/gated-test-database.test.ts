import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { withTimeout } from "@stll/concurrency/with-timeout";

import { forceClosePool, terminateReserved } from "@/api/db/sql-close";
import { PG_DRIVER_ERROR } from "@/api/lib/pg-error";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

import { withGatedTestClients } from "./gated-test-database";

const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const sessionSchema = v.object({ pid: v.number() });

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
              timeoutMs: 2000,
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
            timeoutMs: 2000,
          });
          expect(
            await withTimeout(async () => await query, {
              label: "terminated reserved query rejection",
              timeoutMs: 2000,
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
