/**
 * The database roles the migrations create, read from the migration SQL
 * itself.
 *
 * A role belongs to the whole server, not to one database, so it survives a
 * dropped database; `seed-reset.ts` drops these roles too, or the next
 * migration run would fail on `CREATE ROLE` for a role that already exists.
 * Reading the list from the migrations keeps a new role from being missed.
 * Roles that exist before any migration runs (the application's own login)
 * are never in this list.
 */

import { panic } from "better-result";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROLE_NAME = String.raw`"?([a-z_][a-z0-9_]*)"?`;
const CREATE_ROLE = new RegExp(
  String.raw`\bCREATE\s+ROLE\s+${ROLE_NAME}`,
  "giu",
);

/** The SQL with comments removed, so a comment naming a role creates none. */
const withoutComments = (sql: string): string =>
  sql.replaceAll(/\/\*[\s\S]*?\*\//gu, " ").replaceAll(/--[^\n]*/gu, " ");

/** Every role one migration's SQL creates, in order of appearance. */
export const rolesCreatedBy = (sql: string): string[] =>
  [...withoutComments(sql).matchAll(CREATE_ROLE)].map(
    (match) =>
      match.at(1)?.toLowerCase() ?? panic("CREATE ROLE matched without a name"),
  );

/**
 * Whether a migration creates `role` only when it is missing: inside a block
 * that first checks `pg_roles` for that name, so running it against a server
 * that already has the role does not fail.
 */
const createsRoleIfMissing = (sql: string, role: string): boolean =>
  new RegExp(
    String.raw`NOT\s+EXISTS\s*\(\s*SELECT\b[^;]*?\bFROM\s+(?:pg_catalog\.)?pg_roles\b[^;]*?\brolname\s*=\s*'${role}'`,
    "iu",
  ).test(withoutComments(sql));

/** Roles a migration creates without first checking that they are missing. */
export const unguardedRolesCreatedBy = (sql: string): string[] =>
  rolesCreatedBy(sql).filter((role) => !createsRoleIfMissing(sql, role));

type MigrationRoles = { migration: string; roles: string[] };

/** Each migration folder under `drizzleDir` that creates roles, with its roles. */
export const migrationRoleCreations = (drizzleDir: string): MigrationRoles[] =>
  readdirSync(drizzleDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()
    .flatMap((migration) => {
      const sql = readFileSync(
        path.join(drizzleDir, migration, "migration.sql"),
        "utf-8",
      );
      const roles = rolesCreatedBy(sql);
      return roles.length === 0 ? [] : [{ migration, roles }];
    });

/** Every role the migrations under `drizzleDir` create, each once. */
export const migrationCreatedRoles = (drizzleDir: string): string[] => [
  ...new Set(migrationRoleCreations(drizzleDir).flatMap(({ roles }) => roles)),
];
