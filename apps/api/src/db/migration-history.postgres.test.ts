import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { readdirSync } from "node:fs";
import nodePath from "node:path";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { runMigrations } from "./migration-runner";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const migrationsFolder = nodePath.resolve(import.meta.dir, "../../drizzle");

describe.skipIf(!enabled)("fresh committed migration history", () => {
  test("every migration applies chronologically to an empty database", async () => {
    const url = databaseUrl ?? panic("DATABASE_URL is required");
    await withGatedTestClients(url, async ({ openClient }) => {
      const admin = openClient({ max: 1 });
      const databaseName = `migration_history_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const freshUrl = new URL(url);
      freshUrl.pathname = `/${databaseName}`;
      await admin.db.execute(
        sql`CREATE DATABASE ${sql.identifier(databaseName)}`,
      );
      try {
        await withGatedTestClients(
          freshUrl.href,
          async ({ openClient: openFreshClient }) => {
            const fresh = openFreshClient({ max: 1 });
            const connection = await fresh.sql.reserve();
            try {
              await runMigrations({
                connection,
                databaseUrl: freshUrl.href,
                migrationsFolder,
                ebs: { type: "disabled" },
              });
            } finally {
              connection.release();
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
      } finally {
        await admin.db.execute(
          sql`DROP DATABASE ${sql.identifier(databaseName)}`,
        );
      }
    });
  }, 180_000);
});
