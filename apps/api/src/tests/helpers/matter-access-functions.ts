import { panic } from "better-result";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

/** Migrations that define the read functions, oldest first; the newest definition wins. */
const MIGRATION_PATHS = [
  "../../../drizzle/20261015090000_matter_access_rule_function/migration.sql",
  "../../../drizzle/20261124200000_matter_visibility/migration.sql",
].map((migration) => nodePath.resolve(import.meta.dir, migration));

/** The read functions and their argument lists, as granted. */
const READ_FUNCTIONS = {
  stella_authorized_workspace_ids: "text, text",
  stella_workspace_access: "text, text, uuid",
} as const;

const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * The matter access rule's read functions, rewritten for a test that builds
 * its own schema of copied tables: they read that schema's tables instead of
 * `public`, and `roles` may execute them. App code calls the functions
 * unqualified, so the test's `search_path` resolves these copies.
 */
export const matterAccessFunctionStatements = (
  schema: string,
  roles: readonly string[],
): string[] => {
  const target = quoteIdentifier(schema);
  const names = Object.keys(READ_FUNCTIONS);
  const latest = new Map<string, string>();
  for (const path of MIGRATION_PATHS) {
    for (const part of readFileSync(path, "utf-8")
      .split("--> statement-breakpoint")
      .map((statement) =>
        statement.replace(/^[ \t]*--[^\n]*\n?/gmu, "").trim(),
      )) {
      const name = names.find(
        (candidate) =>
          part.startsWith(`CREATE FUNCTION public.${candidate}(`) ||
          part.startsWith(`CREATE OR REPLACE FUNCTION public.${candidate}(`),
      );
      if (name !== undefined) {
        latest.set(name, part.replace(/^CREATE OR REPLACE /u, "CREATE "));
      }
    }
  }
  const definitions = [...latest.values()].map((part) =>
    part
      .replaceAll("public.", () => `${target}.`)
      .replace(
        "SET search_path = pg_catalog, public",
        () => `SET search_path = pg_catalog, ${target}`,
      ),
  );
  if (definitions.length !== names.length) {
    panic("The matter access migrations no longer define its read functions");
  }
  const grants = roles.flatMap((role) =>
    Object.entries(READ_FUNCTIONS).map(
      ([name, argumentList]) =>
        `GRANT EXECUTE ON FUNCTION ${target}.${name}(${argumentList}) TO ${quoteIdentifier(role)}`,
    ),
  );
  return [...definitions, ...grants];
};
