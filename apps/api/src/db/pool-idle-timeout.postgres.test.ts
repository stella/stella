import { describe, expect, test } from "bun:test";

import { getPgErrorCode, PG_DRIVER_ERROR, PG_ERROR } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const IDLE_TIMEOUT_S = 3;
const STATEMENT_TIMEOUT_MS = 1000;
const LONG_QUERY_S = 8;
const TEST_TIMEOUT_MS = 10_000;

const failedWith = async (query: Promise<unknown>): Promise<unknown> => {
  try {
    await query;
  } catch (error) {
    return error;
  }
  return undefined;
};

const expectServerCancellation = (error: unknown): void => {
  expect(getPgErrorCode(error)).toBe(PG_ERROR.QUERY_CANCELED);
  expect(error).not.toMatchObject({ code: PG_DRIVER_ERROR.IDLE_TIMEOUT });
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("Bun SQL pool timeout against Postgres", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("Bun SQL pool timeout against Postgres", () => {
    test(
      "server cancels a long query on a fresh connection before Bun's idle timeout",
      async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const client = openClient({
            connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
            idleTimeout: IDLE_TIMEOUT_S,
          }).sql;

          expectServerCancellation(
            await failedWith(client`SELECT pg_sleep(${LONG_QUERY_S})`),
          );
        });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "server cancels on a previously idle pooled connection, then reuses it",
      async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const client = openClient({
            connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
            idleTimeout: IDLE_TIMEOUT_S,
          }).sql;
          const [before] = await client<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          await Bun.sleep(200);

          expectServerCancellation(
            await failedWith(client`SELECT pg_sleep(${LONG_QUERY_S})`),
          );
          const [after] = await client<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          expect(after?.pid).toBe(before?.pid);
        });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "server cancellation rolls back a reserved transaction and pool remains usable",
      async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const client = openClient({
            connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
            idleTimeout: IDLE_TIMEOUT_S,
          }).sql;
          const [before] = await client<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;

          expectServerCancellation(
            await failedWith(
              client.begin(async (tx) => {
                await tx`SELECT pg_sleep(${LONG_QUERY_S})`;
              }),
            ),
          );

          const [after] = await client<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          expect(after?.pid).toBe(before?.pid);
        });
      },
      TEST_TIMEOUT_MS,
    );

    test.each([
      { lockTimeoutMs: 500, expected: PG_ERROR.LOCK_NOT_AVAILABLE },
      { lockTimeoutMs: 2000, expected: PG_ERROR.QUERY_CANCELED },
    ])(
      "a lock wait ends with server error $expected when lock_timeout is $lockTimeoutMs ms",
      async ({ lockTimeoutMs, expected }) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const holder = openClient({ idleTimeout: 0 }).sql;
          const waiter = openClient({
            connection: {
              lock_timeout: lockTimeoutMs,
              statement_timeout: STATEMENT_TIMEOUT_MS,
            },
            idleTimeout: IDLE_TIMEOUT_S,
          }).sql;
          const lockKey = Math.floor(Math.random() * 0x7f_ff_ff_ff);
          const held = Promise.withResolvers<undefined>();
          const release = Promise.withResolvers<undefined>();
          const holding = holder.begin(async (tx) => {
            await tx`SELECT pg_advisory_xact_lock(${lockKey})`;
            held.resolve(undefined);
            await release.promise;
          });

          try {
            await held.promise;
            const error = await failedWith(
              waiter`SELECT pg_advisory_xact_lock(${lockKey})`,
            );
            expect(getPgErrorCode(error)).toBe(expected);
            expect(error).not.toMatchObject({
              code: PG_DRIVER_ERROR.IDLE_TIMEOUT,
            });
          } finally {
            release.resolve(undefined);
            await holding;
          }
        });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a dedicated connection with idleTimeout disabled finishes work beyond the pooled idle limit",
      async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const client = openClient({
            connection: { statement_timeout: 5000 },
            idleTimeout: 0,
          }).sql;
          const rows = await client<{ finished: number }[]>`
          SELECT 1 AS finished FROM pg_sleep(${IDLE_TIMEOUT_S + 0.5})
        `;
          expect(rows.at(0)?.finished).toBe(1);
        });
      },
      TEST_TIMEOUT_MS,
    );
  });
}
