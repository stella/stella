import { panic } from "better-result";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { MigrationConfig } from "drizzle-orm/migrator";

import { unguardedRolesCreatedBy } from "./migration-roles";

/** Replay only historical NOLOGIN role creation; retain the source ledger hashes. */
export const sharedTestTemplateMigrations = (config: MigrationConfig) =>
  readMigrationFiles(config).map((migration) => ({
    ...migration,
    sql: migration.sql.map((statement) => {
      const roles = unguardedRolesCreatedBy(statement);
      if (roles.length === 0) {
        return statement;
      }
      let guarded = statement;
      for (const role of roles) {
        const creation = new RegExp(
          `^((?:\\s|--[^\\n]*(?:\\n|$)|/\\*[\\s\\S]*?\\*/)*?)CREATE\\s+ROLE\\s+"?(${role})"?\\s+NOLOGIN\\s*;`,
          "iu",
        );
        const match = creation.exec(guarded);
        const prefix = match?.at(1);
        if (prefix === undefined || match?.at(2) !== role) {
          panic("Unsupported shared template role creation");
        }
        guarded = guarded.replace(
          creation,
          () => `${prefix}DO $shared_role$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
            CREATE ROLE "${role}" NOLOGIN;
          END IF;
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}' AND
              (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
            RAISE EXCEPTION 'Shared template role posture conflicts: ${role}';
          END IF;
        END $shared_role$;`,
        );
      }
      return guarded;
    }),
  }));
