import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AUTH_USER_STELLA_SELECT_COLUMN_NAMES } from "@/api/db/auth-schema";

const DRIZZLE_DIR = resolve(import.meta.dir, "../../../drizzle");

const identifierNamesFromSql = (sqlList: string): string[] =>
  [...sqlList.matchAll(/"([^"]+)"|([a-z_][a-z0-9_]*)/giu)].map(
    (match) => match[1] ?? match[2] ?? "",
  );

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
  const prefix = "GRANT SELECT (";
  if (!statement.toUpperCase().startsWith(prefix)) {
    return null;
  }

  const body = statement.slice(prefix.length);
  const marker = ') ON TABLE "USER" TO ';
  const suffixStart = body.toUpperCase().lastIndexOf(marker);
  if (
    suffixStart === -1 ||
    !isStellaIdentifier(body.slice(suffixStart + marker.length))
  ) {
    return null;
  }

  return body.slice(0, suffixStart);
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
