import { describe, expect, test } from "bun:test";

import { withGatedTestClients } from "../tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("maintenance checkpoint row security", () => {
  test("forced RLS permits a plain owner and denies a grantee all checkpoint access", async () => {
    if (databaseUrl === undefined) {
      throw new TypeError("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const client = openClient().sql;
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const schema = `checkpoint_${suffix}`;
      const owner = `checkpoint_owner_${suffix}`;
      const reader = `checkpoint_reader_${suffix}`;
      const migration = await Bun.file(
        new URL(
          "../../drizzle/20261001123000_database_backfill_state/migration.sql",
          import.meta.url,
        ),
      ).text();
      await client.unsafe("BEGIN");
      try {
        const version = await client.unsafe<{ version: number }[]>(
          "SELECT current_setting('server_version_num')::int AS version",
        );
        expect(version.at(0)?.version).toBeGreaterThanOrEqual(180_000);
        expect(version.at(0)?.version).toBeLessThan(190_000);
        await client.unsafe(`CREATE SCHEMA ${schema}`);
        await client.unsafe(
          `CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
        );
        await client.unsafe(
          `CREATE ROLE ${reader} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
        );
        await client.unsafe(`SET LOCAL search_path TO ${schema}, public`);
        for (const statement of migration
          .replaceAll(
            "public.database_backfill_states",
            () => `${schema}.database_backfill_states`,
          )
          .split("--> statement-breakpoint")) {
          await client.unsafe(statement);
        }
        const posture = await client.unsafe<
          { enabled: boolean; forced: boolean }[]
        >(
          `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid = '${schema}.database_backfill_states'::regclass`,
        );
        expect(posture.at(0)).toEqual({ enabled: true, forced: true });
        await client.unsafe(
          `ALTER TABLE database_backfill_states OWNER TO ${owner}`,
        );
        await client.unsafe(
          `GRANT USAGE ON SCHEMA ${schema} TO ${owner}, ${reader}`,
        );
        await client.unsafe(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON database_backfill_states TO ${reader}`,
        );
        await client.unsafe(`SET LOCAL ROLE ${owner}`);
        await client.unsafe(
          "INSERT INTO database_backfill_states (name, cursor, batch) VALUES ('repair', '10', '{}')",
        );
        const updated = await client.unsafe<{ cursor: string }[]>(
          "UPDATE database_backfill_states SET cursor = '20' WHERE name = 'repair' RETURNING cursor",
        );
        expect(updated).toEqual([{ cursor: "20" }]);
        await client.unsafe(`SET LOCAL ROLE ${reader}`);
        expect(
          await client.unsafe<{ name: string }[]>(
            "SELECT name FROM database_backfill_states",
          ),
        ).toHaveLength(0);
        expect(
          await client.unsafe<{ name: string }[]>(
            "UPDATE database_backfill_states SET cursor = '30' RETURNING name",
          ),
        ).toHaveLength(0);
        expect(
          await client.unsafe<{ name: string }[]>(
            "DELETE FROM database_backfill_states RETURNING name",
          ),
        ).toHaveLength(0);
        await client.unsafe("SAVEPOINT denied_insert");
        const rejection: unknown = await client
          .unsafe(
            "INSERT INTO database_backfill_states (name, batch) VALUES ('intruder', '{}')",
          )
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(rejection).toBeInstanceOf(Error);
        expect(
          rejection instanceof Error ? rejection.message : String(rejection),
        ).toMatch(/row-level security/u);
        await client.unsafe("ROLLBACK TO SAVEPOINT denied_insert");
        await client.unsafe(`SET LOCAL ROLE ${owner}`);
        expect(
          await client.unsafe<{ name: string; cursor: string }[]>(
            "SELECT name, cursor FROM database_backfill_states",
          ),
        ).toEqual([{ name: "repair", cursor: "20" }]);
        expect(
          await client.unsafe<{ name: string }[]>(
            "DELETE FROM database_backfill_states RETURNING name",
          ),
        ).toEqual([{ name: "repair" }]);
      } finally {
        await client.unsafe("ROLLBACK");
      }
    });
  });
});
