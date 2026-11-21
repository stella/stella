import { panic } from "better-result";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../../drizzle/20261015090000_matter_access_rule_function/migration.sql",
);

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
  const definitions = readFileSync(MIGRATION_PATH, "utf-8")
    .split("--> statement-breakpoint")
    .map((part) => part.replace(/^[ \t]*--[^\n]*\n?/gmu, "").trim())
    .filter((part) =>
      names.some((name) => part.startsWith(`CREATE FUNCTION public.${name}(`)),
    )
    .map((part) =>
      part
        .replaceAll("public.", () => `${target}.`)
        .replace(
          "SET search_path = pg_catalog, public",
          () => `SET search_path = pg_catalog, ${target}`,
        ),
    );
  if (definitions.length !== names.length) {
    panic("The matter access migration no longer defines its read functions");
  }
  const grants = roles.flatMap((role) =>
    Object.entries(READ_FUNCTIONS).map(
      ([name, argumentList]) =>
        `GRANT EXECUTE ON FUNCTION ${target}.${name}(${argumentList}) TO ${quoteIdentifier(role)}`,
    ),
  );
  return [...definitions, ...grants];
};
