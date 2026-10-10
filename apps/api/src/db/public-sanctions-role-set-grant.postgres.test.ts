import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { withGatedTestClients } from "../tests/gated-test-database";
import { stellaPublicSanctionsReader } from "./rls";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const migrationPath = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20261003122400_public_sanctions_reader/migration.sql",
);

if (!runPostgresTests || databaseUrl === undefined) {
  describe.skip("public sanctions role SET grant", () => {
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
    `public sanctions role SET grant (PostgreSQL ${String(version)}; requires PostgreSQL 16+)`,
    () => {
      test("upgrades an ADMIN-only creator membership and converges on replay", async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const admin = openClient().sql;
          const connection = await openClient().sql.reserve();
          const suffix = Bun.randomUUIDv7().replaceAll("-", "");
          const creator = `sanctions_creator_${suffix}`;
          const ingestion = `sanctions_probe_${suffix}`;
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
              stellaPublicSanctionsReader.name,
              () => ingestion,
            );
            const grant = /DO \$\$[\s\S]*?END \$\$;/u.exec(migration)?.at(0);
            if (grant === undefined) {
              panic("Public sanctions role grant is missing");
            }
            const apply = async () => await connection.unsafe(grant);
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
