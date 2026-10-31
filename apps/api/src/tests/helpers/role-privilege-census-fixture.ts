import type { SQL } from "bun";
import path from "node:path";

import { runMigrations } from "../../db/migration-runner";
import {
  type Census,
  readRolePrivilegeCensus,
} from "../../lib/db/role-privilege-census";
import { withGatedTestClients } from "../gated-test-database";
import { withIsolatedPostgresCluster } from "../isolated-postgres-cluster";

const migrationsFolder = path.resolve(import.meta.dir, "../../../drizzle");

export const withMigratedRolePrivilegeCensus = async (
  run: (database: SQL, census: Census) => void | Promise<void>,
) => {
  await withIsolatedPostgresCluster(
    {
      prefix: "role-census",
      database: "stella",
      user: "census_admin",
      password: "fixture",
    },
    async (scratchUrl) => {
      await withGatedTestClients(scratchUrl, async ({ openClient }) => {
        const database = openClient().sql;
        const connection = await database.reserve();
        try {
          await runMigrations({
            connection,
            databaseUrl: scratchUrl,
            migrationsFolder,
            ebs: { type: "disabled" },
          });
        } finally {
          await connection.release();
        }
        await run(database, await readRolePrivilegeCensus(database));
      });
    },
  );
};
