import { panic } from "better-result";
import { sql } from "drizzle-orm";
import nodePath from "node:path";

import { rootDb } from "@/api/db/root";
import { assertDatabaseLoginPosture } from "@/api/lib/db/assert-database-login-posture";
import {
  type AppliedMigration,
  assertMigrationHistory,
} from "@/api/lib/db/migration-history";
import {
  type ApplicationRlsRolePosture,
  applicationRlsRolePostureViolation,
  type IngestionRolePosture,
  ingestionRolePostureViolation,
} from "@/api/lib/db/rls-role-posture";
import { logger } from "@/api/lib/observability/logger";

import { assertOnlineMigrationsApplied } from "../../db/online-migrations";
import {
  APPLICATION_RLS_ROLE_NAME,
  INGESTION_ROLE_NAME,
} from "../../db/role-names";

const MIGRATIONS_DIR = nodePath.resolve(process.cwd(), "drizzle");
const ESCAPE_HATCH_ENV = "SKIP_MIGRATION_CHECK";

export const assertApplicationRlsRolePosture = async (
  database: typeof rootDb,
): Promise<void> => {
  const result = await database.execute<ApplicationRlsRolePosture>(sql`
    SELECT
      app_role.rolbypassrls AS "bypassesRls",
      pg_has_role(CURRENT_USER, app_role.oid, 'SET') AS "canAssumeRole",
      app_role.rolcanlogin AS "canLogin",
      app_role.rolsuper AS "isSuperuser",
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class relation
        WHERE relation.relowner = app_role.oid
          AND relation.relkind IN ('r', 'p')
          AND relation.relrowsecurity
      ) AS "ownsRlsTable"
    FROM pg_catalog.pg_roles app_role
    WHERE app_role.rolname = ${APPLICATION_RLS_ROLE_NAME}
  `);
  const violation = applicationRlsRolePostureViolation(result.at(0));
  if (violation !== null) {
    panic(violation);
  }
};

const assertIngestionRolePosture = async (): Promise<void> => {
  const result = await rootDb.execute<IngestionRolePosture>(sql`
    SELECT pg_has_role(CURRENT_USER, ingestion_role.oid, 'SET') AS "canAssumeRole"
    FROM pg_catalog.pg_roles ingestion_role
    WHERE ingestion_role.rolname = ${INGESTION_ROLE_NAME}
  `);
  const violation = ingestionRolePostureViolation(result.at(0));
  if (violation !== null) {
    panic(violation);
  }
};

const queryAppliedRows = async (): Promise<readonly AppliedMigration[]> => {
  const result = await rootDb.execute<AppliedMigration>(
    sql`SELECT name, hash FROM drizzle.__drizzle_migrations`,
  );
  return result;
};

export const assertMigrationsApplied = async (): Promise<void> => {
  await assertDatabaseLoginPosture(rootDb);
  await assertApplicationRlsRolePosture(rootDb);
  await assertIngestionRolePosture();
  if (process.env[ESCAPE_HATCH_ENV] === "true") {
    logger.warn("startup.migration_check_disabled", {
      escape_hatch_env: ESCAPE_HATCH_ENV,
    });
    return;
  }

  await assertMigrationHistory({
    context: "startup",
    migrationsDir: MIGRATIONS_DIR,
    queryAppliedRows,
    remedy:
      `Run \`bun run db:migrate\` against this database, or set ${ESCAPE_HATCH_ENV}=true ` +
      "to bypass the check (emergency only).",
  });
  await assertOnlineMigrationsApplied({
    reserve: async () => {
      const connection = await rootDb.$client.reserve();
      return {
        execute: async (query, params = []) => {
          await connection.unsafe(query, [...params]);
        },
        query: async (query, params = []) =>
          await connection.unsafe(query, [...params]),
        release: async () => {
          await connection.release();
        },
      };
    },
  });
};
