import { panic } from "better-result";
import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

import {
  MIGRATE_ONLINE_WORK_MODE,
  type MigrateOnlineWorkMode,
} from "./migrate-online-work-mode";
import { runMigrationsUntilSettled } from "./migration-runner";
import { ONLINE_WORK_LIFECYCLE } from "./online-work-lifecycle";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const migrationsFolder = nodePath.resolve(import.meta.dir, "../../drizzle");

// The import upserts name these as ON CONFLICT arbiters from their first
// release, so no migrate run may finish without them.
const IMPORT_ARBITERS = [
  "contacts_org_external_uidx",
  "correspondence_org_external_uidx",
  "expenses_org_external_uidx",
  "invoices_org_external_uidx",
  "time_entries_org_external_uidx",
  "workspaces_org_external_uidx",
];

const deployBlocking = Object.entries(ONLINE_WORK_LIFECYCLE)
  .flatMap(([name, { state }]) => (state === "deploy_blocking" ? [name] : []))
  .toSorted();

const indexValidity = async (admin: SQL, names: readonly string[]) => {
  const rows = await admin<{ name: string; valid: boolean }[]>`
    SELECT c.relname AS name, i.indisvalid AS valid
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'`;
  return rows
    .filter(({ name }) => names.includes(name))
    .map(({ name, valid }) => ({ name, valid }))
    .toSorted((left, right) => (left.name < right.name ? -1 : 1));
};

// CI owns this isolated PostgreSQL database and applies the committed bundle.
describe.skipIf(!runPostgresTests)("deploy-blocking online work", () => {
  // timeout: two migrate runs over the committed bundle build online indexes
  test("every migrate run leaves deploy-blocking indexes valid, a release's verify_finalized run included", async () => {
    expect(deployBlocking).toEqual(expect.arrayContaining(IMPORT_ARBITERS));
    const url = databaseUrl ?? panic("DATABASE_URL is required");
    await withGatedTestClients(url, async ({ openClient }) => {
      const { sql: admin } = openClient({ max: 1 });
      const migrate = async (onlineWorkMode: MigrateOnlineWorkMode) => {
        const connection = await admin.reserve();
        try {
          return await runMigrationsUntilSettled({
            onlineWorkMode,
            connection,
            migrationsFolder,
            databaseUrl: url,
            ebs: { type: "disabled" },
          });
        } finally {
          await connection.release();
        }
      };
      const allValid = deployBlocking.map((name) => ({ name, valid: true }));

      await migrate(MIGRATE_ONLINE_WORK_MODE.BUILD_FINALIZED);
      expect(await indexValidity(admin, deployBlocking)).toEqual(allValid);

      // A release database whose deploy-blocking indexes are absent: the
      // release's own migrate run builds them before it reports success.
      for (const name of deployBlocking) {
        await admin.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
      }
      expect(await indexValidity(admin, deployBlocking)).toEqual([]);
      expect(
        await migrate(MIGRATE_ONLINE_WORK_MODE.VERIFY_FINALIZED),
      ).toMatchObject({ status: "applied" });
      expect(await indexValidity(admin, deployBlocking)).toEqual(allValid);
    });
  }, 180_000);
});
