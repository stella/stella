import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import { rootDb } from "@/api/db/root";
import { envBase } from "@/api/env-base";
import {
  assertDatabaseLoginPosture,
  readDatabaseLoginPosture,
} from "@/api/lib/db/assert-database-login-posture";
import { assertApplicationRlsRolePosture } from "@/api/lib/db/assert-migrations-applied";
import {
  DatabaseLoginPostureError,
  UNSAFE_DATABASE_LOGIN_LOCAL_DEV_ENV,
} from "@/api/lib/db/rls-role-posture";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import {
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import { createTestState } from "@/api/tests/helpers/test-state";
import { withIsolatedPostgresCluster } from "@/api/tests/isolated-postgres-cluster";

const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const testState = createTestState({ file: import.meta.path, config: envBase });

const capturePostureRejection = async (database = rootDb) =>
  await assertApplicationRlsRolePosture(database).then(
    () => null,
    (error: unknown) => error,
  );

// Role attributes are cluster-wide: provision the elevated role in a separate
// cluster so no concurrent suite or application session can assume it.
const withElevatedApplicationRole = async (
  run: (db: GatedTestDb, admin: SQL) => Promise<void>,
) =>
  await withIsolatedPostgresCluster(
    {
      prefix: "rls-posture",
      database: "stella",
      user: "fixture_admin",
      password: "fixture",
    },
    async (adminUrl) => {
      await withGatedTestClients(adminUrl, async ({ openClient }) => {
        const admin = openClient().sql;
        await admin.unsafe(`CREATE ROLE stella NOLOGIN NOSUPERUSER BYPASSRLS;
          CREATE ROLE fixture_owner LOGIN PASSWORD 'fixture' NOSUPERUSER NOBYPASSRLS;
          GRANT stella TO fixture_owner WITH INHERIT FALSE, SET TRUE;
          ALTER DATABASE stella OWNER TO fixture_owner`);
        const applicationUrl = new URL(adminUrl);
        applicationUrl.username = "fixture_owner";
        applicationUrl.password = "fixture";
        const { db } = openClient({ databaseUrl: applicationUrl.href });
        const posture = await db.execute<{
          superuser: boolean;
          bypass: boolean;
        }>(
          sql`SELECT rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
        );
        expect(posture.at(0)).toEqual({ superuser: false, bypass: false });
        await run(db, admin);
      });
    },
  );

if (!runPostgresTests) {
  describe.skip("application RLS role database posture", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true", () => {
      expect(runPostgresTests).toBe(false);
    });
  });
} else {
  describe("application RLS role database posture", () => {
    test("accepts the migrated application role", async () => {
      expect(await capturePostureRejection()).toBeNull();
    });

    test("rejects application roles with superuser or bypass privileges", async () => {
      await withElevatedApplicationRole(async (db, admin) => {
        const applicationPosture = async () =>
          await db.execute<{
            superuser: boolean;
            bypass: boolean;
            canAssumeRole: boolean;
          }>(sql`SELECT rolsuper AS superuser, rolbypassrls AS bypass,
            pg_has_role(CURRENT_USER, oid, 'SET') AS "canAssumeRole"
            FROM pg_roles WHERE rolname = 'stella'`);
        expect((await applicationPosture()).at(0)).toEqual({
          superuser: false,
          bypass: true,
          canAssumeRole: true,
        });
        expect(await capturePostureRejection(db)).toMatchObject({
          message: "Application RLS role must not bypass row security.",
        });

        await admin.unsafe("ALTER ROLE stella SUPERUSER NOBYPASSRLS");
        expect((await applicationPosture()).at(0)).toEqual({
          superuser: true,
          bypass: false,
          canAssumeRole: true,
        });
        expect(await capturePostureRejection(db)).toMatchObject({
          message: "Application RLS role must not bypass row security.",
        });
      });
    }, 30_000);

    test("admits demoted authenticated logins and requires a local development opt-in for elevated attributes", async () => {
      await withElevatedApplicationRole(async (db, admin) => {
        for (const attributes of [
          { isSuperuser: false, bypassesRls: false, admitted: true },
          { isSuperuser: true, bypassesRls: false, admitted: false },
          { isSuperuser: false, bypassesRls: true, admitted: false },
          { isSuperuser: true, bypassesRls: true, admitted: false },
        ]) {
          await admin.unsafe(
            `ALTER ROLE fixture_owner ${attributes.isSuperuser ? "SUPERUSER" : "NOSUPERUSER"} ${attributes.bypassesRls ? "BYPASSRLS" : "NOBYPASSRLS"}`,
          );
          expect(await readDatabaseLoginPosture(db)).toEqual({
            loginName: "fixture_owner",
            isSuperuser: attributes.isSuperuser,
            bypassesRls: attributes.bypassesRls,
            ownedPolicyTables: 0,
          });
          for (const mode of Object.values(RUNTIME_MODE)) {
            const restoreRuntime = setRuntimeModeForTesting({ mode });
            try {
              for (const unsafeLocalDevOptIn of [undefined, "1", "true"]) {
                testState.setConfig(
                  UNSAFE_DATABASE_LOGIN_LOCAL_DEV_ENV,
                  unsafeLocalDevOptIn,
                );
                const admitted =
                  unsafeLocalDevOptIn === undefined
                    ? attributes.admitted
                    : unsafeLocalDevOptIn === "1" && mode === RUNTIME_MODE.open;
                if (admitted) {
                  await assertDatabaseLoginPosture(db);
                  continue;
                }
                expect(
                  await rejectionOf(assertDatabaseLoginPosture(db)),
                ).toBeInstanceOf(DatabaseLoginPostureError);
              }
            } finally {
              restoreRuntime();
            }
          }
        }
      });
    }, 30_000);

    test("inspects the authenticated login while a transaction assumes another role", async () => {
      await withElevatedApplicationRole(async (db) => {
        await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE stella`);
          const current = await tx.execute<{ name: string }>(
            sql`SELECT CURRENT_USER AS name`,
          );
          expect(current.at(0)?.name).toBe("stella");
          expect(await readDatabaseLoginPosture(tx)).toEqual({
            loginName: "fixture_owner",
            isSuperuser: false,
            bypassesRls: false,
            ownedPolicyTables: 0,
          });
        });
      });
    }, 30_000);

    test("reports the connecting login's attributes", async () => {
      const [current] = await rootDb.execute<{ name: string }>(
        sql`SELECT CURRENT_USER AS name`,
      );
      const posture = await readDatabaseLoginPosture(rootDb);

      expect(posture?.loginName).toBe(current?.name);
      // Tests run as the login that applied the migrations, which owns them.
      expect(posture?.ownedPolicyTables).toBeGreaterThan(0);
    });
  });
}
