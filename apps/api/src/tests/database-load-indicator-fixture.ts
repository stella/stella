import type { SQL } from "bun";
import { expect } from "bun:test";

import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

type IndicatorFixture = {
  client: SQL;
  db: GatedTestDb;
  migration: string;
  unrelatedRole: string;
};

/** template0 ensures this test cannot reuse a previously installed definer. */
export const withFreshIndicatorDatabase = async (
  databaseUrl: string,
  work: (fixture: IndicatorFixture) => Promise<void>,
) => {
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const admin = openClient().sql;
    const suffix = Bun.randomUUIDv7().replaceAll("-", "");
    const database = `load_indicator_${suffix}`;
    const unrelatedRole = `load_unrelated_${suffix}`;
    await admin.unsafe(
      `CREATE ROLE ${unrelatedRole} NOLOGIN NOSUPERUSER NOINHERIT`,
    );
    try {
      await admin.unsafe(`CREATE DATABASE ${database} TEMPLATE template0`);
      try {
        const url = new URL(databaseUrl);
        url.pathname = `/${database}`;
        await withGatedTestClients(url.toString(), async (scope) => {
          // The lane fixture holds one connection while corpus work uses the other.
          const { sql: client, db } = scope.openClient({ max: 2 });
          const absent = (
            await client.unsafe<{ absent: boolean }[]>(
              "SELECT to_regprocedure('public.stella_database_load_indicators(regclass)') IS NULL AS absent",
            )
          ).at(0);
          expect(absent?.absent).toBe(true);
          const migration = await Bun.file(
            new URL(
              "../../drizzle/20261003123600_database_load_indicators/migration.sql",
              import.meta.url,
            ),
          ).text();
          await client.begin(async (tx) => {
            for (const statement of migration.split(
              "--> statement-breakpoint",
            )) {
              if (statement.trim().length > 0) {
                await tx.unsafe(statement);
              }
            }
          });
          await work({ client, db, migration, unrelatedRole });
        });
      } finally {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      }
    } finally {
      await admin.unsafe(`DROP ROLE ${unrelatedRole}`);
    }
  });
};
