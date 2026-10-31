import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { readdirSync } from "node:fs";
import nodePath from "node:path";

import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { withIsolatedPostgresCluster } from "@/api/tests/isolated-postgres-cluster";

import { runMigrations } from "./migration-runner";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const migrationsFolder = nodePath.resolve(import.meta.dir, "../../drizzle");

describe.skipIf(!enabled)("fresh committed migration history", () => {
  // timeout: The isolated cluster applies the full committed migration chain; each statement retains its migration-owned deadline.
  test("every migration applies chronologically to an empty database", async () => {
    await withIsolatedPostgresCluster(
      {
        prefix: "migration-history",
        database: "migration_history",
        user: "migration_owner",
        password: "migration-fixture-password",
        directory: nodePath.resolve(import.meta.dir, "../../node_modules"),
      },
      async (databaseUrl) => {
        await withGatedTestClients(
          databaseUrl,
          async ({ openClient: openFreshClient }) => {
            const fresh = openFreshClient({ max: 1 });
            const connection = await fresh.sql.reserve();
            try {
              await runMigrations({
                connection,
                databaseUrl,
                migrationsFolder,
                ebs: { type: "disabled" },
              });
            } finally {
              await connection.release();
            }
            const expected = readdirSync(migrationsFolder, {
              withFileTypes: true,
            })
              .filter((entry) => entry.isDirectory())
              .map((entry) => entry.name)
              .toSorted();
            const recorded = await fresh.db.execute<{ name: string }>(sql`
          SELECT name FROM drizzle.__drizzle_migrations ORDER BY id
        `);
            expect(recorded.map((row) => row.name)).toEqual(expected);
            const [creation] = await fresh.db.execute<{
              legacy: string | null;
              explicit: string | null;
              visibility: boolean;
            }>(sql`
          SELECT
            to_regprocedure('public.stella_create_workspace(uuid,uuid,text,text,text,text,text)')::text AS legacy,
            to_regprocedure('public.stella_create_workspace(uuid,uuid,text,text,text,text,text,text)')::text AS explicit,
            EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.workspaces'::regclass AND attname = 'visibility' AND NOT attisdropped) AS visibility
        `);
            expect(creation).toMatchObject({
              legacy: expect.any(String),
              explicit: expect.any(String),
              visibility: true,
            });
          },
        );
      },
    );
  }, 180_000);
});
