import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AUTH_USER_STELLA_SELECT_COLUMN_NAMES } from "@/api/db/auth-schema";

const DRIZZLE_DIR = resolve(import.meta.dir, "../../../drizzle");
const SQL_IDENTIFIER_PATTERN = /"([^"]+)"|([a-z_][a-z0-9_]*)/giu;
const GRANT_SELECT_COLUMN_PREFIX_PATTERN = /^GRANT\s+SELECT\s*\(/iu;
const GRANT_SELECT_COLUMN_TABLE_PATTERN = /\)\s+ON\s+TABLE\s+/iu;

const identifierNamesFromSql = (sqlList: string): string[] =>
  [...sqlList.matchAll(SQL_IDENTIFIER_PATTERN)].map((match) => {
    if (match[1] !== undefined) {
      return match[1];
    }

    return match[2]?.toLowerCase() ?? "";
  });

const parseColumnList = (sqlList: string): string[] =>
  identifierNamesFromSql(sqlList).filter((name) => name.length > 0);

const stripSqlLineComments = (contents: string): string =>
  contents
    .split(/\r?\n/u)
    .map((line) => {
      const commentStart = line.indexOf("--");
      return commentStart === -1 ? line : line.slice(0, commentStart);
    })
    .join("\n");

const sqlStatements = (contents: string): string[] =>
  stripSqlLineComments(contents)
    .split(";")
    .map((statement) => statement.replace(/\s+/gu, " ").trim())
    .filter((statement) => statement.length > 0);

const revokeAuthTableList = (statement: string): string | null => {
  const prefix = "REVOKE ALL PRIVILEGES ON TABLE ";
  if (!statement.toUpperCase().startsWith(prefix)) {
    return null;
  }

  return stripTargetRole(statement.slice(prefix.length), "FROM");
};

const tableSelectGrantList = (statement: string): string | null => {
  const prefix = "GRANT SELECT ON TABLE ";
  if (!statement.toUpperCase().startsWith(prefix)) {
    return null;
  }

  return stripTargetRole(statement.slice(prefix.length), "TO");
};

const userColumnSelectGrantList = (statement: string): string | null => {
  const prefixMatch = GRANT_SELECT_COLUMN_PREFIX_PATTERN.exec(statement);
  if (!prefixMatch) {
    return null;
  }

  const body = statement.slice(prefixMatch[0].length);
  const tableMarkerMatch = GRANT_SELECT_COLUMN_TABLE_PATTERN.exec(body);
  if (!tableMarkerMatch) {
    return null;
  }

  const tableTarget = stripTargetRole(
    body.slice(tableMarkerMatch.index + tableMarkerMatch[0].length),
    "TO",
  );
  if (!tableTarget || identifierNamesFromSql(tableTarget).at(-1) !== "user") {
    return null;
  }

  return body.slice(0, tableMarkerMatch.index);
};

const stripTargetRole = (
  body: string,
  keyword: "FROM" | "TO",
): string | null => {
  const marker = ` ${keyword} `;
  const markerIndex = body.toUpperCase().lastIndexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  const target = body.slice(markerIndex + marker.length);
  if (!isStellaIdentifier(target)) {
    return null;
  }

  return body.slice(0, markerIndex).trim();
};

const isStellaIdentifier = (value: string): boolean =>
  value.trim().toLowerCase() === "stella" ||
  value.trim().toLowerCase() === '"stella"';

const migrationSqlFiles = () =>
  readdirSync(DRIZZLE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(DRIZZLE_DIR, entry.name, "migration.sql"))
    .filter((path) => existsSync(path))
    .toSorted();

describe("auth user RLS grants", () => {
  test("parses SQL identifier variants used by grants", () => {
    expect(identifierNamesFromSql('public."user", ID, email_verified')).toEqual(
      ["public", "user", "id", "email_verified"],
    );
  });

  test("recognizes schema-qualified user column grants", () => {
    expect(
      userColumnSelectGrantList(
        'GRANT SELECT (ID, "email_verified") ON TABLE public."user" TO "stella"',
      ),
    ).toBe('ID, "email_verified"');
    expect(
      userColumnSelectGrantList(
        'GRANT SELECT (id) ON TABLE public."account" TO stella',
      ),
    ).toBeNull();
  });

  test("migrations grant stella every Better Auth user column explicitly", () => {
    const grantedColumns = new Set<string>();
    let hasTableLevelUserSelect = false;

    for (const path of migrationSqlFiles()) {
      const contents = readFileSync(path, "utf-8");

      for (const statement of sqlStatements(contents)) {
        const revokedTables = revokeAuthTableList(statement);
        if (revokedTables) {
          const tables = identifierNamesFromSql(revokedTables);
          if (tables.includes("user")) {
            grantedColumns.clear();
            hasTableLevelUserSelect = false;
          }
        }

        const tableSelectGrants = tableSelectGrantList(statement);
        if (tableSelectGrants) {
          const tables = identifierNamesFromSql(tableSelectGrants);
          if (tables.includes("user")) {
            hasTableLevelUserSelect = true;
          }
        }

        const userColumnGrants = userColumnSelectGrantList(statement);
        if (!userColumnGrants) {
          continue;
        }

        for (const column of parseColumnList(userColumnGrants)) {
          grantedColumns.add(column);
        }
      }
    }

    expect(hasTableLevelUserSelect).toBe(false);
    expect([...grantedColumns].toSorted()).toEqual(
      AUTH_USER_STELLA_SELECT_COLUMN_NAMES.toSorted(),
    );
  });
});
