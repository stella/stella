import { panic } from "better-result";
import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
) => {
  const root = mkdtempSync(path.join(tmpdir(), "rls-posture-"));
  const dataDir = path.join(root, "data");
  const socketDir = path.join(root, "sock");
  const native = Bun.which("initdb");
  const fixture =
    native === null
      ? ({
          type: "container",
          name: `rls-posture-${Bun.randomUUIDv7()}`,
        } as const)
      : ({ type: "native", initdb: native } as const);
  const command = (cmd: string[]) =>
    Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  const checked = (cmd: string[]) => {
    const result = command(cmd);
    if (result.exitCode !== 0) {
      panic(
        `Role fixture command failed: ${new TextDecoder().decode(result.stderr)}`,
      );
    }
  };
  let started = false;
  try {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data: () => undefined },
    });
    const port = String(listener.port);
    listener.stop(true);
    const passwordFile = path.join(root, "password");
    writeFileSync(passwordFile, "fixture\n", { mode: 0o600 });
    mkdirSync(socketDir);
    switch (fixture.type) {
      case "native":
        checked([
          fixture.initdb,
          "-D",
          dataDir,
          "-U",
          "fixture_admin",
          "--auth-local=trust",
          "--auth-host=scram-sha-256",
          `--pwfile=${passwordFile}`,
          "-E",
          "utf-8",
          "--locale=en_US.UTF-8",
        ]);
        started = true;
        checked([
          "pg_ctl",
          "-D",
          dataDir,
          "-w",
          "-l",
          path.join(root, "postgres.log"),
          "-o",
          `-c listen_addresses=127.0.0.1 -c port=${port} -c unix_socket_directories=${socketDir}`,
          "start",
        ]);
        checked([
          "createdb",
          "-h",
          socketDir,
          "-p",
          port,
          "-U",
          "fixture_admin",
          "stella",
        ]);
        break;
      case "container":
        started = true;
        checked([
          "docker",
          "run",
          "--name",
          fixture.name,
          "-e",
          "POSTGRES_USER=fixture_admin",
          "-e",
          "POSTGRES_PASSWORD=fixture",
          "-e",
          "POSTGRES_DB=stella",
          "-p",
          `127.0.0.1:${port}:5432`,
          "-d",
          "postgres:18.6",
        ]);
        break;
      default:
        fixture satisfies never;
    }
    const deadline = Date.now() + 10_000;
    const readiness =
      fixture.type === "native"
        ? [
            "pg_isready",
            "-h",
            "127.0.0.1",
            "-p",
            port,
            "-U",
            "fixture_admin",
            "-d",
            "stella",
          ]
        : [
            "docker",
            "exec",
            fixture.name,
            "pg_isready",
            "-h",
            "127.0.0.1",
            "-U",
            "fixture_admin",
            "-d",
            "stella",
          ];
    while (command(readiness).exitCode !== 0) {
      if (Date.now() >= deadline) {
        panic("Role fixture did not become ready");
      }
      await Bun.sleep(100);
    }
    const adminUrl = `postgres://fixture_admin:fixture@127.0.0.1:${port}/stella`;
    await withGatedTestClients(adminUrl, async ({ openClient }) => {
      const admin = openClient().sql;
      await admin.unsafe(`CREATE ROLE stella NOLOGIN NOSUPERUSER BYPASSRLS;
        CREATE ROLE fixture_owner LOGIN PASSWORD 'fixture' NOSUPERUSER NOBYPASSRLS;
        GRANT stella TO fixture_owner WITH INHERIT FALSE, SET TRUE;
        ALTER DATABASE stella OWNER TO fixture_owner`);
      const { db } = openClient({
        databaseUrl: `postgres://fixture_owner:fixture@127.0.0.1:${port}/stella`,
      });
      const posture = await db.execute<{ superuser: boolean; bypass: boolean }>(
        sql`SELECT rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
      );
      expect(posture.at(0)).toEqual({ superuser: false, bypass: false });
      await run(db, admin);
    });
  } finally {
    try {
      if (started) {
        switch (fixture.type) {
          case "native":
            checked(["pg_ctl", "-D", dataDir, "-m", "immediate", "-w", "stop"]);
            break;
          case "container":
            checked(["docker", "rm", "-fv", fixture.name]);
            break;
          default:
            fixture satisfies never;
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
};

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
