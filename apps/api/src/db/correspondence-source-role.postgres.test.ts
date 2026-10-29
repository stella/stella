import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { runMigrations } from "./migration-runner";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const migrationsFolder = nodePath.resolve(import.meta.dir, "../../drizzle");
const role = "stella_correspondence_source";
const routinePrivilegeQuery = `SELECT routine.proname AS routine, privilege.privilege_type AS privilege
        FROM pg_catalog.pg_proc routine
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = routine.pronamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(routine.proacl,
          pg_catalog.acldefault('f', routine.proowner))) privilege
        WHERE namespace.nspname = 'public'
          AND privilege.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
        ORDER BY routine.proname, privilege.privilege_type`;

describe.skipIf(!runPostgresTests)(
  "migrated correspondence source role",
  () => {
    // timeout: Applying the complete committed migration bundle can exceed Bun's default test timeout.
    test("keeps only the catalog privileges required for source maintenance", async () => {
      const url = databaseUrl ?? panic("DATABASE_URL is required");
      await withGatedTestClients(url, async ({ openClient }) => {
        const admin = openClient({ max: 1 }).sql;
        const connection = await admin.reserve();
        try {
          await runMigrations({
            connection,
            migrationsFolder,
            databaseUrl: url,
            ebs: { type: "disabled" },
          });
        } finally {
          await connection.release();
        }

        const posture = await admin.unsafe<
          {
            canLogin: boolean;
            isSuperuser: boolean;
            bypassesRls: boolean;
            canCreateDatabase: boolean;
            canCreateRole: boolean;
            canReplicate: boolean;
          }[]
        >(
          `SELECT rolcanlogin AS "canLogin", rolsuper AS "isSuperuser",
          rolbypassrls AS "bypassesRls", rolcreatedb AS "canCreateDatabase",
          rolcreaterole AS "canCreateRole", rolreplication AS "canReplicate"
        FROM pg_catalog.pg_roles WHERE rolname = $1`,
          [role],
        );
        expect([...posture]).toEqual([
          {
            canLogin: false,
            isSuperuser: false,
            bypassesRls: false,
            canCreateDatabase: false,
            canCreateRole: false,
            canReplicate: false,
          },
        ]);

        const tablePrivileges = await admin.unsafe<
          { table: string; privilege: string }[]
        >(
          `SELECT table_name AS "table", privilege_type AS privilege
        FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee = $1
        ORDER BY table_name, privilege_type`,
          [role],
        );
        expect([...tablePrivileges]).toEqual([
          { table: "correspondence", privilege: "DELETE" },
          { table: "correspondence_sources", privilege: "DELETE" },
        ]);

        const columnPrivileges = await admin.unsafe<
          { table: string; column: string; privilege: string }[]
        >(
          `SELECT table_name AS "table", column_name AS "column",
          privilege_type AS privilege
        FROM information_schema.role_column_grants
        WHERE table_schema = 'public' AND grantee = $1
        ORDER BY table_name, column_name, privilege_type`,
          [role],
        );
        expect([...columnPrivileges]).toEqual([
          {
            table: "correspondence",
            column: "entity_feature_gate",
            privilege: "SELECT",
          },
          { table: "correspondence", column: "id", privilege: "SELECT" },
          {
            table: "correspondence",
            column: "organization_id",
            privilege: "SELECT",
          },
          {
            table: "correspondence",
            column: "source_entity_id",
            privilege: "SELECT",
          },
          {
            table: "correspondence",
            column: "source_entity_id",
            privilege: "UPDATE",
          },
          {
            table: "correspondence",
            column: "updated_at",
            privilege: "UPDATE",
          },
          {
            table: "correspondence",
            column: "workspace_id",
            privilege: "SELECT",
          },
          {
            table: "correspondence_sources",
            column: "correspondence_id",
            privilege: "SELECT",
          },
          {
            table: "correspondence_sources",
            column: "entity_feature_gate",
            privilege: "SELECT",
          },
          {
            table: "correspondence_sources",
            column: "entity_id",
            privilege: "SELECT",
          },
          {
            table: "correspondence_sources",
            column: "organization_id",
            privilege: "SELECT",
          },
          {
            table: "correspondence_sources",
            column: "workspace_id",
            privilege: "SELECT",
          },
        ]);

        const sequencePrivileges = await admin.unsafe<
          { sequence: string; privilege: string }[]
        >(
          `SELECT object_name AS sequence, privilege_type AS privilege
        FROM information_schema.role_usage_grants
        WHERE object_schema = 'public' AND object_type = 'SEQUENCE'
          AND grantee = $1
        ORDER BY object_name, privilege_type`,
          [role],
        );
        expect([...sequencePrivileges]).toEqual([]);

        const routinePrivileges = await admin.unsafe<
          { routine: string; privilege: string }[]
        >(routinePrivilegeQuery, [role]);
        // Information-schema grant views hide non-inheriting owner roles from
        // a non-superuser. Read their owned and explicitly granted ACL entries.
        expect([...routinePrivileges]).toEqual([
          { routine: "correspondence_has_other_sources", privilege: "EXECUTE" },
          { routine: "next_correspondence_source", privilege: "EXECUTE" },
          { routine: "remove_correspondence_source", privilege: "EXECUTE" },
          {
            routine: "remove_entity_correspondence_sources",
            privilege: "EXECUTE",
          },
          { routine: "stella_authorized_workspace_ids", privilege: "EXECUTE" },
        ]);

        const schemaPrivileges = await admin.unsafe<
          { usage: boolean; create: boolean }[]
        >(
          `SELECT has_schema_privilege($1, 'public', 'USAGE') AS usage,
          has_schema_privilege($1, 'public', 'CREATE') AS create`,
          [role],
        );
        expect([...schemaPrivileges]).toEqual([{ usage: true, create: false }]);

        const memberships = await admin.unsafe<
          { isMigratingUser: boolean; inherits: boolean; canSet: boolean }[]
        >(
          `SELECT membership.member = current_user::regrole AS "isMigratingUser",
          membership.inherit_option AS inherits,
          membership.set_option AS "canSet"
        FROM pg_catalog.pg_auth_members membership
        JOIN pg_catalog.pg_roles granted
          ON granted.oid = membership.roleid
        JOIN pg_catalog.pg_roles member
          ON member.oid = membership.member
        WHERE granted.rolname = $1
        ORDER BY member.rolname`,
          [role],
        );
        expect([...memberships]).toEqual([
          { isMigratingUser: true, inherits: false, canSet: false },
        ]);
      });
    }, 120_000);
  },
);
