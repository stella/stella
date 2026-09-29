import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { withGatedTestClients } from "../tests/gated-test-database";
import { INGESTION_ROLE_NAME } from "./role-names";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const migrationPath = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20261003122400_ingestion_role_set_grant/migration.sql",
);

if (!runPostgresTests || databaseUrl === undefined) {
  describe.skip("ingestion role SET grant", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && databaseUrl !== undefined).toBe(false);
    });
  });
} else {
  const version = await withGatedTestClients(
    databaseUrl,
    async ({ openClient }) => {
      const rows = await openClient().sql.unsafe<
        { server_version_num: string }[]
      >("SHOW server_version_num");
      return Number(
        rows.at(0)?.server_version_num ??
          panic("PostgreSQL version is missing"),
      );
    },
  );
  describe.skipIf(version < 160_000)(
    `ingestion role SET grant (PostgreSQL ${String(version)}; requires PostgreSQL 16+)`,
    () => {
      test("upgrades an ADMIN-only creator membership and converges on replay", async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const admin = openClient().sql;
          const connection = await openClient().sql.reserve();
          const suffix = Bun.randomUUIDv7().replaceAll("-", "");
          const creator = `ingestion_creator_${suffix}`;
          const ingestion = `ingestion_probe_${suffix}`;
          // Both identifiers are generated from fixed prefixes and UUID hex.
          try {
            await admin.unsafe(`CREATE ROLE "${creator}" LOGIN CREATEROLE`);
            await connection.unsafe(`SET ROLE "${creator}"`);
            await connection.unsafe(`CREATE ROLE "${ingestion}" NOLOGIN`);
            // Role-switch permissions follow session_user: remove the original
            // superuser identity so the successful SET ROLE is meaningful.
            await connection.unsafe(`SET SESSION AUTHORIZATION "${creator}"`);
            const posture = await connection.unsafe<
              {
                name: string;
                sessionName: string;
                isSuperuser: boolean;
                canCreateRole: boolean;
              }[]
            >(`
              SELECT CURRENT_USER AS name, SESSION_USER AS "sessionName",
                rolsuper AS "isSuperuser",
                rolcreaterole AS "canCreateRole"
              FROM pg_roles WHERE rolname = CURRENT_USER
            `);
            expect(posture.at(0)).toEqual({
              name: creator,
              sessionName: creator,
              isSuperuser: false,
              canCreateRole: true,
            });
            const grantOptions = async () =>
              await connection.unsafe<
                {
                  grantor: number;
                  admin: boolean;
                  inherits: boolean;
                  canSet: boolean;
                }[]
              >(
                `SELECT grantor, admin_option AS admin, inherit_option AS inherits,
                  set_option AS "canSet" FROM pg_auth_members
                 WHERE roleid = (SELECT oid FROM pg_roles WHERE rolname = $1)
                   AND member = (SELECT oid FROM pg_roles WHERE rolname = $2)
                 ORDER BY grantor`,
                [ingestion, creator],
              );
            const creatorGrant = await grantOptions();
            expect(creatorGrant).toHaveLength(1);
            expect(creatorGrant.at(0)).toMatchObject({
              admin: true,
              inherits: false,
              canSet: false,
            });
            const membership = async () =>
              await connection.unsafe<{ member: boolean; canSet: boolean }[]>(
                `SELECT pg_has_role($1, $2, 'MEMBER') AS member,
                  pg_has_role($1, $2, 'SET') AS "canSet"`,
                [creator, ingestion],
              );
            // A MEMBER guard skips this membership even though SET is denied.
            expect((await membership()).at(0)).toEqual({
              member: true,
              canSet: false,
            });
            const migration = (await Bun.file(migrationPath).text()).replaceAll(
              INGESTION_ROLE_NAME,
              () => ingestion,
            );
            const apply = async () => {
              for (const statement of migration.split(
                "--> statement-breakpoint",
              )) {
                await connection.unsafe(statement);
              }
            };
            await apply();
            expect((await membership()).at(0)).toEqual({
              member: true,
              canSet: true,
            });
            const granted = await grantOptions();
            await connection.unsafe(`SET ROLE "${ingestion}"`);
            const assumed = await connection.unsafe<{ name: string }[]>(
              "SELECT CURRENT_USER AS name",
            );
            expect(assumed.at(0)?.name).toBe(ingestion);
            await connection.unsafe("RESET ROLE");
            await apply();
            expect(await grantOptions()).toEqual(granted);
            expect((await membership()).at(0)).toEqual({
              member: true,
              canSet: true,
            });
          } finally {
            connection.release();
            await admin.unsafe(
              `DROP ROLE IF EXISTS "${ingestion}", "${creator}"`,
            );
          }
        });
      });
    },
  );
}
