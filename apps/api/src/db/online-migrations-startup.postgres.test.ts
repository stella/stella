import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { withGatedTestClients } from "../tests/gated-test-database";
import { assertOnlineMigrationsApplied } from "./online-migrations";

/**
 * A migrate run holds the online lock for each index build, for longer than
 * the database's statement timeout. Startup validation on another session
 * must return while that lock is held, and hand its pooled session back with
 * the timeout it had.
 */

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const ONLINE_LOCK_KEY = "hashtext('stella-online-migrations')";
/** Far below the 5 s startup budget a wait on the lock would run into. */
const RETURN_WITHIN_MS = 2000;

describe.skipIf(!enabled)("startup validation during a migrate run", () => {
  test("returns at once while another session holds the online lock", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL is required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const migrator = openClient().sql;
      const booting = await openClient().sql.reserve();
      await migrator.unsafe(`SELECT pg_advisory_lock(${ONLINE_LOCK_KEY})`);
      try {
        // A session's own timeout, which RESET would replace with the default.
        await booting.unsafe("SET statement_timeout = '42s'");
        const started = performance.now();
        const outcome = await assertOnlineMigrationsApplied({
          reserve: async () => ({
            execute: async (query, params = []) => {
              await booting.unsafe(query, [...params]);
            },
            query: async (query, params = []) =>
              await booting.unsafe(query, [...params]),
            release: () => undefined,
          }),
        });
        expect(outcome).toEqual({ type: "migrator_active" });
        expect(performance.now() - started).toBeLessThan(RETURN_WITHIN_MS);
        expect(await booting.unsafe("SHOW statement_timeout")).toEqual([
          { statement_timeout: "42s" },
        ]);
        const held = await booting.unsafe(
          `SELECT count(*)::int AS held FROM pg_locks
           WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
        );
        expect(held).toEqual([{ held: 0 }]);
      } finally {
        await migrator.unsafe(`SELECT pg_advisory_unlock(${ONLINE_LOCK_KEY})`);
        await booting.release();
      }
    });
  });
});
