import { panic } from "better-result";
import { sql } from "drizzle-orm";
import nodePath from "node:path";

import { rootDb } from "@/api/db/root";
import { assertMigrationHistory } from "@/api/lib/db/migration-history";
import {
  type ApplicationRlsRolePosture,
  applicationRlsRolePostureViolation,
} from "@/api/lib/db/rls-role-posture";
import { logger } from "@/api/lib/observability/logger";

import { assertOnlineMigrationsApplied } from "../../db/online-migrations";
import { APPLICATION_RLS_ROLE_NAME } from "../../db/role-names";

const MIGRATIONS_DIR = nodePath.resolve(process.cwd(), "drizzle");
const ESCAPE_HATCH_ENV = "SKIP_MIGRATION_CHECK";

type AppliedMigrationRow = { hash: string };

const assertApplicationRlsRolePosture = async (): Promise<void> => {
  const result = await rootDb.execute<ApplicationRlsRolePosture>(sql`
    SELECT
      app_role.rolcanlogin AS "canLogin",
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

const queryAppliedHashes = async (): Promise<Set<string>> => {
  // Compare on `hash` (always populated) rather than `name` (NULL
  // on rows applied by older drizzle versions). Hash is the SHA-256
  // of the migration.sql contents at apply time, so a mismatch
  // also catches a file edited after it was applied.
  const result = await rootDb.execute<AppliedMigrationRow>(
    sql`SELECT hash FROM drizzle.__drizzle_migrations`,
  );
  return new Set(result.map((row) => row.hash));
};

export const assertMigrationsApplied = async (): Promise<void> => {
  await assertApplicationRlsRolePosture();
  if (process.env[ESCAPE_HATCH_ENV] === "true") {
    logger.warn("startup.migration_check_disabled", {
      escape_hatch_env: ESCAPE_HATCH_ENV,
    });
    return;
  }

  await assertMigrationHistory({
    context: "startup",
    migrationsDir: MIGRATIONS_DIR,
    queryAppliedHashes,
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
        release: () => connection.release(),
      };
    },
  });
};
