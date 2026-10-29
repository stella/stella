import path from "node:path";

import {
  readRolePrivilegeCensus,
  writeRolePrivilegeCensus,
} from "@/api/lib/db/role-privilege-census";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { withIsolatedPostgresCluster } from "@/api/tests/isolated-postgres-cluster";

import { runMigrations } from "../src/db/migration-runner";

const migrationsFolder = path.resolve(import.meta.dir, "../drizzle");

await withIsolatedPostgresCluster(
  {
    prefix: "role-census-update",
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
      await writeRolePrivilegeCensus(await readRolePrivilegeCensus(database));
    });
  },
);
