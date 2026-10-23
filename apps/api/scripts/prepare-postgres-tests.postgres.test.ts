import { panic } from "better-result";
import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { createTestState } from "@/api/tests/helpers/test-state";

import {
  PostgresTestMigrationError,
  preparePostgresTests,
} from "./prepare-postgres-tests";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const testState = createTestState({ file: import.meta.path, config: {} });

setDefaultTimeout(120_000);

describe.skipIf(!runPostgresTests)("Postgres test preparation", () => {
  test("migrates a fresh database or reports a typed migration failure", async () => {
    const url = databaseUrl ?? panic("DATABASE_URL is required");
    const database = `stella_prepare_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    await withGatedTestClients(url, async ({ openClient }) => {
      const admin = openClient().sql;
      await admin.unsafe(`CREATE DATABASE "${database}" TEMPLATE template0`);
      const scratchUrl = new URL(url);
      scratchUrl.pathname = `/${database}`;
      testState.setEnv("DATABASE_URL", scratchUrl.href);
      try {
        let migrationError: unknown;
        try {
          await preparePostgresTests();
        } catch (error) {
          migrationError = error;
        }
        await withGatedTestClients(
          scratchUrl.href,
          async ({ openClient: openScratchClient }) => {
            const rows = await openScratchClient().sql<
              { relation: string | null }[]
            >`SELECT to_regclass('public.oauth_resource')::text AS relation`;

            if (migrationError !== undefined) {
              expect(migrationError).toBeInstanceOf(PostgresTestMigrationError);
              return;
            }
            expect(rows.at(0)?.relation).toBe("oauth_resource");
          },
        );
      } finally {
        await admin.unsafe(`DROP DATABASE "${database}"`);
      }
    });
  });
});
