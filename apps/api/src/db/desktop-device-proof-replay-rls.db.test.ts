import { describe, expect, test } from "bun:test";

import { withGatedTestClients } from "../tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("desktop device proof replay row security", () => {
  test("forced RLS confines every operation to the table owner", async () => {
    if (databaseUrl === undefined) {
      throw new TypeError("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const client = openClient().sql;
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const schema = `desktop_proof_${suffix}`;
      const owner = `desktop_proof_owner_${suffix}`;
      const reader = `desktop_proof_reader_${suffix}`;
      const migration = await Bun.file(
        new URL(
          "../../drizzle/20261005120600_desktop_device_proof_replays/migration.sql",
          import.meta.url,
        ),
      ).text();

      await client.unsafe("BEGIN");
      try {
        await client.unsafe(`CREATE SCHEMA ${schema}`);
        await client.unsafe(
          `CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
        );
        await client.unsafe(
          `CREATE ROLE ${reader} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
        );
        await client.unsafe(`SET LOCAL search_path TO ${schema}, public`);
        const rewrittenMigration = migration.replaceAll(
          "public.desktop_device_proof_replays",
          () => `${schema}.desktop_device_proof_replays`,
        );
        for (const statement of rewrittenMigration.split(
          "--> statement-breakpoint",
        )) {
          if (statement.trim().length > 0) {
            await client.unsafe(statement);
          }
        }

        await client.unsafe(
          `GRANT USAGE ON SCHEMA ${schema} TO ${owner}, ${reader}`,
        );
        await client.unsafe(
          `ALTER TABLE ${schema}.desktop_device_proof_replays OWNER TO ${owner}`,
        );
        await client.unsafe(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ${schema}.desktop_device_proof_replays TO ${reader}`,
        );
        const posture = await client.unsafe<
          { enabled: boolean; forced: boolean }[]
        >(
          `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid = '${schema}.desktop_device_proof_replays'::regclass`,
        );
        expect(posture.at(0)).toEqual({ enabled: true, forced: true });
        const denyPolicy = await client.unsafe<
          { roles: string[]; qual: string; with_check: string }[]
        >(
          `SELECT roles, qual, with_check FROM pg_policies WHERE schemaname = '${schema}' AND tablename = 'desktop_device_proof_replays' AND policyname = 'auth_no_stella_access'`,
        );
        expect(denyPolicy.at(0)).toEqual({
          roles: ["stella"],
          qual: "false",
          with_check: "false",
        });

        await client.unsafe(`SET LOCAL ROLE ${owner}`);
        await client.unsafe(
          "INSERT INTO desktop_device_proof_replays (jkt, jti, expires_at) VALUES ('thumbprint', 'proof-id', now() + interval '1 minute')",
        );
        await client.unsafe(`SET LOCAL ROLE ${reader}`);
        expect(
          await client.unsafe<Record<string, unknown>[]>(
            "SELECT * FROM desktop_device_proof_replays",
          ),
        ).toHaveLength(0);
        expect(
          await client.unsafe<Record<string, unknown>[]>(
            "UPDATE desktop_device_proof_replays SET expires_at = now() RETURNING jti",
          ),
        ).toHaveLength(0);
        expect(
          await client.unsafe<Record<string, unknown>[]>(
            "DELETE FROM desktop_device_proof_replays RETURNING jti",
          ),
        ).toHaveLength(0);
        await client.unsafe("SAVEPOINT denied_insert");
        const rejection: unknown = await client
          .unsafe(
            "INSERT INTO desktop_device_proof_replays (jkt, jti, expires_at) VALUES ('reader', 'proof-id', now() + interval '1 minute')",
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
      } finally {
        await client.unsafe("ROLLBACK");
      }
    });
  });
});
