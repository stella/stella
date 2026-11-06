import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

/**
 * Deployed services retire pooled connections by age, because every prepared
 * statement stays on its connection until then and a task otherwise holds
 * gigabytes of database memory within a day. That is only safe while the driver
 * lets running work finish, which some Bun releases did not: they killed the
 * query at the timer. A runtime upgrade that brings that back fails here rather
 * than as aborted requests.
 */
const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const LIFETIME_S = 1;
const PAST_LIFETIME_S = LIFETIME_S * 2;

const requiredDatabaseUrl = (): string =>
  databaseUrl ?? panic("DATABASE_URL required");

describe.skipIf(!runPostgresTests)("connection retirement (postgres)", () => {
  test("a query outlives the connection lifetime", async () => {
    await withGatedTestClients(
      requiredDatabaseUrl(),
      async ({ openClient }) => {
        const { sql } = openClient({ maxLifetime: LIFETIME_S });
        const before: { pid: number }[] =
          await sql`SELECT pg_backend_pid() AS pid`;
        const during: { pid: number }[] =
          await sql`SELECT pg_sleep(${PAST_LIFETIME_S}), pg_backend_pid() AS pid`;
        expect(during.at(0)?.pid).toBe(before.at(0)?.pid);
      },
    );
  });

  test("a transaction outlives the connection lifetime", async () => {
    await withGatedTestClients(
      requiredDatabaseUrl(),
      async ({ openClient }) => {
        const { sql } = openClient({ maxLifetime: LIFETIME_S });
        const seen = await sql.begin(async (tx) => {
          const first: { pid: number }[] =
            await tx`SELECT pg_backend_pid() AS pid`;
          await tx`SELECT pg_sleep(${PAST_LIFETIME_S})`;
          const last: { pid: number }[] =
            await tx`SELECT pg_backend_pid() AS pid`;
          return [first.at(0)?.pid, last.at(0)?.pid];
        });
        expect(seen.at(0)).toBe(seen.at(1));
      },
    );
  });

  test("an idle connection past its lifetime is replaced", async () => {
    await withGatedTestClients(
      requiredDatabaseUrl(),
      async ({ openClient }) => {
        const { sql } = openClient({ maxLifetime: LIFETIME_S });
        const { sql: clock } = openClient();
        const before: { pid: number }[] =
          await sql`SELECT pg_backend_pid() AS pid`;
        // The wait runs on a second connection, so the first one stays idle.
        await clock`SELECT pg_sleep(${PAST_LIFETIME_S})`;
        const after: { pid: number }[] =
          await sql`SELECT pg_backend_pid() AS pid`;
        expect(after.at(0)?.pid).not.toBe(before.at(0)?.pid);
      },
    );
  });

  test("one statement shape holds no per-length memory", async () => {
    await withGatedTestClients(
      requiredDatabaseUrl(),
      async ({ openClient }) => {
        const { sql } = openClient();
        const held = async (): Promise<number> => {
          const rows: { bytes: string | bigint }[] =
            await sql`SELECT sum(total_bytes) AS bytes FROM pg_backend_memory_contexts`;
          return Number(rows.at(0)?.bytes ?? 0);
        };
        const before = await held();
        for (let length = 1; length <= 200; length++) {
          const payload = JSON.stringify(
            Array.from({ length }, (_, index) => ({ value: `v${index}` })),
          );
          await sql`SELECT count(*) FROM jsonb_to_recordset(${payload}::text::jsonb) AS row(value text)`;
        }
        // A statement per length holds tens of megabytes here: the reason
        // `no-variable-arity-values` keeps data out of a statement's text.
        expect((await held()) - before).toBeLessThan(4 * 1024 * 1024);
      },
    );
  });
});
