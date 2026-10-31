import { panic } from "better-result";
import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

import {
  MIGRATE_ONLINE_WORK_MODE,
  type MigrateOnlineWorkMode,
} from "./migrate-online-work-mode";
import { runMigrations, runMigrationsUntilSettled } from "./migration-runner";
import { declaresOnlineBuild } from "./online-ddl";
import type { OnlineMigrationPool } from "./online-migration-connection";
import {
  ONLINE_MIGRATION_INDEXES,
  ONLINE_MIGRATION_REPAIRS,
  reportOnlineMigrations,
} from "./online-migrations";
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

const PENDING_INDEXES = ONLINE_MIGRATION_INDEXES.filter(
  ({ name }) => ONLINE_WORK_LIFECYCLE[name].state === "pending",
);

/** Startup validation over one reserved session, which stays the caller's. */
const sessionPool = (session: SQL): OnlineMigrationPool => ({
  reserve: async () => ({
    execute: async (query, params = []) => {
      await session.unsafe(query, [...params]);
    },
    query: async (query, params = []) =>
      await session.unsafe(query, [...params]),
    release: () => undefined,
  }),
});

type Validation = {
  type: "validated" | "migrator_active" | "threw";
  pending: readonly string[];
  message?: string;
};

/** What startup validation ended with, a throw included, as plain data. */
const validationOf = async (session: SQL): Promise<Validation> => {
  try {
    const outcome = await reportOnlineMigrations(sessionPool(session), {
      repairs: ONLINE_MIGRATION_REPAIRS,
    });
    return outcome.type === "validated"
      ? {
          type: outcome.type,
          pending: outcome.report.pending.map(({ name }) => name),
        }
      : { type: outcome.type, pending: [] };
  } catch (error) {
    return {
      type: "threw",
      pending: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

// CI owns this isolated PostgreSQL database and applies the committed bundle.
describe.skipIf(!runPostgresTests)("deploy-blocking online work", () => {
  // The suites' database starts empty and is migrated with build_finalized,
  // so pending work and the work that waits on it are absent here.
  // timeout: a migrate run over the committed bundle builds online indexes
  test("startup validates a database build_finalized migrated, leaving pending work pending", async () => {
    const url = databaseUrl ?? panic("DATABASE_URL is required");
    await withGatedTestClients(url, async ({ openClient }) => {
      const { sql: admin } = openClient({ max: 1 });
      const connection = await admin.reserve();
      try {
        expect(
          await runMigrationsUntilSettled({
            onlineWorkMode: MIGRATE_ONLINE_WORK_MODE.BUILD_FINALIZED,
            connection,
            migrationsFolder,
            databaseUrl: url,
            ebs: { type: "disabled" },
          }),
        ).toMatchObject({ status: "applied" });
        const validation = await validationOf(connection);
        expect(validation).toMatchObject({ type: "validated" });
        // The tenant key waits for its unique index, the foreign key
        // validation for the tenant key that installs it, and the client
        // backfill for its partial index: each stays pending.
        expect(validation.pending).toEqual(
          expect.arrayContaining([
            "invoices_id_org_unique",
            "client-invoice-tenant-key",
            "invoices_original_organization_fk",
            "invoices_client_backfill_idx",
            "client-invoice-clients",
          ]),
        );
      } finally {
        await connection.release();
      }
    });
  }, 180_000);

  // Each pending index can be the one the post-deploy runner has not built
  // yet. Startup validation over every such state reports that index pending
  // and never fails on work that presupposes it. Each state is built and
  // discarded inside one transaction.
  // timeout: a migrate run over the committed bundle builds online indexes
  test("startup validates a database missing any one pending online index, reporting it pending", async () => {
    expect(PENDING_INDEXES.length).toBeGreaterThan(0);
    const url = databaseUrl ?? panic("DATABASE_URL is required");
    await withGatedTestClients(url, async ({ openClient }) => {
      const { sql: admin } = openClient({ max: 1 });
      const connection = await admin.reserve();
      try {
        await runMigrationsUntilSettled({
          onlineWorkMode: MIGRATE_ONLINE_WORK_MODE.BUILD_FINALIZED,
          connection,
          migrationsFolder,
          databaseUrl: url,
          ebs: { type: "disabled" },
        });
        await connection.unsafe("BEGIN");
        try {
          for (const index of PENDING_INDEXES) {
            const [present] = await connection<{ present: boolean }[]>`
              SELECT to_regclass(${`public."${index.name}"`}) IS NOT NULL AS present`;
            if (present?.present !== true) {
              const build = (
                declaresOnlineBuild(index)
                  ? index.createSql
                  : panic(`Pending index ${index.name} has no build`)
              ).replace(/\bCONCURRENTLY\s+/u, "");
              await connection.unsafe(build);
            }
          }
          const outcomes: {
            name: string;
            validation: Omit<Validation, "pending">;
            reportsItPending: boolean;
          }[] = [];
          for (const { name } of PENDING_INDEXES) {
            await connection.unsafe("SAVEPOINT one_index_missing");
            await connection.unsafe(`DROP INDEX public."${name}"`);
            const { pending, ...validation } = await validationOf(connection);
            await connection.unsafe("ROLLBACK TO SAVEPOINT one_index_missing");
            outcomes.push({
              name,
              validation,
              reportsItPending: pending.includes(name),
            });
          }
          expect(outcomes).toEqual(
            PENDING_INDEXES.map(({ name }) => ({
              name,
              validation: { type: "validated" },
              reportsItPending: true,
            })),
          );
        } finally {
          await connection.unsafe("ROLLBACK");
        }
      } finally {
        await connection.release();
      }
    });
  }, 180_000);

  // timeout: four migrate runs over the committed bundle build online indexes
  test("every migrate run leaves deploy-blocking indexes valid, and a release's run fails when one cannot be built", async () => {
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
      const dropDeployBlocking = async () => {
        for (const name of deployBlocking) {
          await admin.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
        }
        expect(await indexValidity(admin, deployBlocking)).toEqual([]);
      };

      await migrate(MIGRATE_ONLINE_WORK_MODE.BUILD_FINALIZED);
      expect(await indexValidity(admin, deployBlocking)).toEqual(allValid);

      // A release database whose deploy-blocking indexes are absent: the
      // release's own migrate run builds them before it reports success.
      await dropDeployBlocking();
      expect(
        await migrate(MIGRATE_ONLINE_WORK_MODE.VERIFY_FINALIZED),
      ).toMatchObject({ status: "applied" });
      expect(await indexValidity(admin, deployBlocking)).toEqual(allValid);

      // Rows the arbiter cannot hold: the release's migrate run fails rather
      // than serve upserts with no unique index behind them.
      await dropDeployBlocking();
      const organization = Bun.randomUUIDv7();
      const duplicates = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
      try {
        await admin`INSERT INTO organization (id, name, slug, created_at) VALUES (${organization}, 'Duplicate import tenant', ${organization}, now())`;
        for (const contact of duplicates) {
          await admin`INSERT INTO contacts (id, organization_id, type, display_name, external_source, external_id, external_change_key, imported_at)
            VALUES (${contact}, ${organization}, 'person', 'Duplicate import', 'fixture-import', 'same-ref', 'v1', now())`;
        }
        const migrateRelease = async () => {
          const connection = await admin.reserve();
          try {
            return await runMigrations({
              onlineWorkMode: MIGRATE_ONLINE_WORK_MODE.VERIFY_FINALIZED,
              connection,
              migrationsFolder,
              databaseUrl: url,
              ebs: { type: "disabled" },
            });
          } finally {
            await connection.release();
          }
        };
        const rejection = await rejectionOf(migrateRelease());
        expect(rejection).toBeInstanceOf(Error);
        const left = await indexValidity(admin, ["contacts_org_external_uidx"]);
        expect(left.every(({ valid }) => !valid)).toBe(true);
      } finally {
        await admin`DELETE FROM contacts WHERE id IN (${duplicates.at(0)}, ${duplicates.at(1)})`;
        await admin`DELETE FROM organization WHERE id = ${organization}`;
      }

      // The suites after this one find the arbiters as migrate leaves them.
      expect(
        await migrate(MIGRATE_ONLINE_WORK_MODE.VERIFY_FINALIZED),
      ).toMatchObject({ status: "applied" });
      expect(await indexValidity(admin, deployBlocking)).toEqual(allValid);
    });
  }, 300_000);
});
