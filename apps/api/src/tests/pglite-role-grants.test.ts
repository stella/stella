import { describe, expect, test } from "bun:test";
import { getTableName, isTable } from "drizzle-orm";
import { readdir } from "node:fs/promises";
import nodePath from "node:path";

import * as schema from "@/api/db/schema";
import { ROLE_GRANT_STATEMENTS } from "@/api/tests/pglite-test-db";

/**
 * The PGlite harness hand-maintains the role grants the committed migrations
 * apply, because it builds its schema by pushing the Drizzle definitions
 * rather than by replaying 300 migrations. A hand-maintained mirror drifts:
 * `case_law_reconciliation_items` was granted to `stella_ingestion` in a
 * migration and never here, so every suite that SET ROLE'd to ingestion saw a
 * permission error the real deployment does not have.
 *
 * This is the mirror check. Every `(role, table)` pair a committed migration
 * grants must also be granted by the harness, for every table the schema still
 * defines. It compares the pairs, not the verbs: the harness deliberately
 * spells some grants more coarsely (one statement per role rather than per
 * migration), and a table nobody may touch at all is the failure worth
 * catching.
 */

const MIGRATIONS_DIR = nodePath.resolve(import.meta.dir, "../../drizzle");

/**
 * Roles the harness grants wholesale, so a per-table pair adds nothing.
 * `stella` holds `ON ALL TABLES IN SCHEMA public`.
 */
const WHOLESALE_ROLES = new Set(["stella", "public"]);

/**
 * Column grants are compared for every role but `public`: the harness narrows
 * `stella` table by table, and those column lists must match the deployment.
 */
const COLUMN_UNSCOPED_ROLES = new Set(["public"]);

const GRANT_STATEMENT =
  /\bGRANT\b([\s\S]*?)\bTO\s+("?[a-zA-Z_][a-zA-Z0-9_]*"?)\s*(?:;|$)/gu;

const OBJECT_CLAUSE = /\bON\s+(?:TABLE\s+)?([\s\S]*?)$/u;

const NOT_A_TABLE_GRANT =
  /\bON\s+(?:ALL\s+TABLES|ALL\s+SEQUENCES|SCHEMA|SEQUENCE|FUNCTION|PROCEDURE|ROUTINE|DATABASE|TYPE|LARGE\s+OBJECT)\b/iu;

const IDENTIFIER = /"([a-zA-Z_][a-zA-Z0-9_]*)"|\b([a-z_][a-z0-9_]*)\b/gu;

const PRIVILEGE_WORDS = new Set([
  "grant",
  "select",
  "insert",
  "update",
  "delete",
  "truncate",
  "references",
  "trigger",
  "maintain",
  "usage",
  "create",
  "connect",
  "temporary",
  "execute",
  "all",
  "privileges",
  "on",
  "table",
  "to",
  "with",
  "option",
]);

/**
 * A column-scoped grant carries its list in parentheses after the privilege
 * and before `ON`, which the table parser above deliberately discards.
 */
const COLUMN_GRANT =
  /\b(SELECT|INSERT|UPDATE|REFERENCES)\s*\(([^)]*)\)[\s\S]*?\bON\s+(?:TABLE\s+)?("?[a-zA-Z_][a-zA-Z0-9_]*"?)/giu;

const unquote = (value: string): string => value.replaceAll('"', "");

const REVOKE_FROM_STELLA =
  /\bREVOKE\s+([A-Z,\s]+?)\s+ON\s+(?:TABLE\s+)?([^;]*?)\bFROM\s+stella\b/giu;

const COLUMN_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "REFERENCES"];

/**
 * Every table-level `stella` privilege the given SQL revokes, as
 * `table:PRIVILEGE`; `ALL` stands for each privilege a column grant can hold.
 */
const tablePrivilegesRevokedFromStella = (sqlText: string): Set<string> => {
  const revoked = new Set<string>();
  for (const match of sqlText.matchAll(REVOKE_FROM_STELLA)) {
    const [, privilegeList = "", objects = ""] = match;
    const privileges = privilegeList
      .split(",")
      .map((privilege) => privilege.trim().toUpperCase());
    const expanded = privileges.some((privilege) => privilege.startsWith("ALL"))
      ? COLUMN_PRIVILEGES
      : privileges;
    for (const identifier of objects.matchAll(IDENTIFIER)) {
      const name = identifier[1] ?? identifier[2] ?? "";
      if (name.length > 0 && !PRIVILEGE_WORDS.has(name.toLowerCase())) {
        for (const privilege of expanded) {
          revoked.add(`${name}:${privilege}`);
        }
      }
    }
  }
  return revoked;
};

/** Every `(role, table)` pair the given SQL grants, as `role:table`. */
const grantedPairs = (sqlText: string): Set<string> => {
  const pairs = new Set<string>();
  for (const match of sqlText.matchAll(GRANT_STATEMENT)) {
    const [, body = "", rawRole = ""] = match;
    if (NOT_A_TABLE_GRANT.test(body)) {
      continue;
    }
    const objects = OBJECT_CLAUSE.exec(body)?.[1];
    if (objects === undefined) {
      continue;
    }
    const role = unquote(rawRole);
    // A column grant carries its column list in parentheses before `ON`; the
    // object clause starts after it, so only table names survive here.
    for (const identifier of objects.matchAll(IDENTIFIER)) {
      const name = identifier[1] ?? identifier[2] ?? "";
      if (name.length === 0 || PRIVILEGE_WORDS.has(name.toLowerCase())) {
        continue;
      }
      pairs.add(`${role}:${name}`);
    }
  }
  return pairs;
};

/**
 * Every `(role, table, column, privilege)` the given SQL grants column by
 * column, as `role:table:column:PRIVILEGE`.
 */
const grantedColumnPairs = (sqlText: string): Set<string> => {
  const pairs = new Set<string>();
  for (const match of sqlText.matchAll(GRANT_STATEMENT)) {
    const [, body = "", rawRole = ""] = match;
    const role = unquote(rawRole);
    for (const columnGrant of body.matchAll(COLUMN_GRANT)) {
      const [, privilege = "", columnList = "", rawTable = ""] = columnGrant;
      const table = unquote(rawTable);
      for (const rawColumn of columnList.split(",")) {
        const column = unquote(rawColumn.trim());
        if (column.length > 0) {
          pairs.add(`${role}:${table}:${column}:${privilege.toUpperCase()}`);
        }
      }
    }
  }
  return pairs;
};

const schemaTableNames = new Set<string>(
  Object.values(schema)
    .filter((value) => isTable(value))
    .map((table) => getTableName(table)),
);

const readMigrationSql = async (): Promise<string> => {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => nodePath.join(MIGRATIONS_DIR, entry.name, "migration.sql"))
    .toSorted();
  const contents = await Promise.all(
    files.map(async (file) => {
      const handle = Bun.file(file);
      return (await handle.exists()) ? await handle.text() : "";
    }),
  );
  // The migrator splits on this marker; joining with `;` keeps each statement
  // terminated for the parser above.
  return contents.join("\n").replaceAll("--> statement-breakpoint", ";");
};

describe("pglite role grants mirror the committed migrations", () => {
  test("the migrations grant no table the harness leaves ungranted", async () => {
    const migrationPairs = grantedPairs(await readMigrationSql());
    const harnessPairs = grantedPairs(ROLE_GRANT_STATEMENTS.join(";\n"));

    const missing = [...migrationPairs]
      .filter((pair) => {
        const [role = "", table = ""] = pair.split(":");
        return (
          !WHOLESALE_ROLES.has(role) &&
          schemaTableNames.has(table) &&
          !harnessPairs.has(pair)
        );
      })
      .toSorted();

    expect(missing).toEqual([]);
  });

  /**
   * Column-scoped grants drift the same way, and worse in both directions. A
   * harness that grants fewer columns than the migrations makes a SET ROLE
   * suite fail on access the deployment has; a harness that grants more makes
   * one pass on access the deployment does not. `stored_total` was the second
   * kind of gap in reverse: the columns landed with a reader grant and none
   * for `stella_ingestion`, and nothing here or in any suite noticed, because
   * the pair check above sees only `stella_ingestion:case_law_sources`.
   *
   * So this compares the sets, both ways. The tables the schema still defines
   * are the scope, for every role including `stella`: its wholesale table
   * grant is narrowed table by table (see the next test), and a column it
   * holds in the harness but not in the deployment would let a scoped suite
   * pass on a statement production refuses.
   */
  test("the migration and harness column grants are the same set", async () => {
    const inScope = (pair: string): boolean => {
      const [role = "", table = ""] = pair.split(":");
      return !COLUMN_UNSCOPED_ROLES.has(role) && schemaTableNames.has(table);
    };
    const migrationColumns = [
      ...grantedColumnPairs(await readMigrationSql()),
    ].filter(inScope);
    const harnessColumns = [
      ...grantedColumnPairs(ROLE_GRANT_STATEMENTS.join(";\n")),
    ].filter(inScope);

    expect(harnessColumns.toSorted()).toEqual(migrationColumns.toSorted());
  });

  /**
   * The harness grants `stella` every table and narrows it afterwards. A table
   * the migrations hold `stella` to column by column must be narrowed here
   * too, or the harness column list is decoration and a scoped suite writes a
   * column the deployment refuses: the cleanup claim on
   * `buffer_object_cleanup_intents` updates its retry schedule, which the
   * request role may write only through an explicit column grant.
   */
  test("tables the migrations hold stella to by column are narrowed in the harness", async () => {
    const migrationColumns = grantedColumnPairs(await readMigrationSql());
    const columnScopedPrivileges = new Set(
      [...migrationColumns]
        .map((pair) => pair.split(":"))
        .filter(
          ([role = "", table = ""]) =>
            role === "stella" && schemaTableNames.has(table),
        )
        .map(([, table = "", , privilege = ""]) => `${table}:${privilege}`),
    );
    const harnessRevoked = tablePrivilegesRevokedFromStella(
      ROLE_GRANT_STATEMENTS.join(";\n"),
    );

    const notNarrowed = [...columnScopedPrivileges]
      .filter((tablePrivilege) => !harnessRevoked.has(tablePrivilege))
      .toSorted();

    expect(
      columnScopedPrivileges.has("buffer_object_cleanup_intents:UPDATE"),
    ).toBe(true);
    expect(notNarrowed).toEqual([]);
  });

  test("the parser reads both migration and harness grant spellings", async () => {
    // A parser that matched nothing would pass the mirror check silently.
    const migrationPairs = grantedPairs(await readMigrationSql());
    const harnessPairs = grantedPairs(ROLE_GRANT_STATEMENTS.join(";\n"));

    expect(migrationPairs.has("stella_ingestion:case_law_decisions")).toBe(
      true,
    );
    expect(
      migrationPairs.has("stella_ingestion:case_law_reconciliation_items"),
    ).toBe(true);
    expect(harnessPairs.has("stella_ingestion:case_law_decisions")).toBe(true);

    // An empty column set on both sides would satisfy the equality above.
    const migrationColumns = grantedColumnPairs(await readMigrationSql());
    const harnessColumns = grantedColumnPairs(
      ROLE_GRANT_STATEMENTS.join(";\n"),
    );
    const storedTotalGrant =
      "stella_ingestion:case_law_sources:stored_total:UPDATE";
    expect(migrationColumns.has(storedTotalGrant)).toBe(true);
    expect(harnessColumns.has(storedTotalGrant)).toBe(true);
  });
});
