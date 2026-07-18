import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

const DRIZZLE_DIR = nodePath.resolve(import.meta.dir, "../../../drizzle");
const BOOTSTRAP_MIGRATION = "20260510140000_document_rls_role_bootstrap";

// These migrations were already in the tree when the bootstrap migration
// introduced the `stella` RLS role and dynamically granted all existing
// RLS tables. Do not add new migrations here; post-bootstrap tables need
// an explicit table grant so existing deployed databases cannot drift.
const BOOTSTRAP_COVERED_RLS_MIGRATIONS = new Set([
  "20260429152450_entity-version-ai-summaries",
  "20260429205610_global-search-indexes",
  "20260429220500_global-search-unaccent",
  "20260430131000_agenda_scheduler_infosoud",
  "20260430211000_type-jsonb-metadata",
  "20260501090000_entity-name-not-null",
  "20260501115500_jsonb-driver-casts",
  "20260501130000_chat-threads-context-matter-ids",
  "20260501131500_case-law-offset-cursors",
  "20260502093000_user-word-edit-preferences",
  "20260502100000_property-status-cleanup",
  "20260503100000_chat-threads-data-workspace-ids",
  "20260503120000_anonymization_blacklist_entries",
  "20260503150000_personal-matters",
  "20260503184500_docx-folio-justifications-types",
  "20260504000000_prompt-shortcuts",
  "20260504100000_chat-threads-organization-scope",
  "20260506100000_cell-metadata",
  "20260507110000_practice-jurisdictions",
  "20260507130000_mcp_connectors",
  "20260507140000_mcp_connection_enabled",
  "20260508152000_mcp_connection_resource_url",
  "20260508161000_mcp_connection_authorization_server_url",
  "20260509220000_disabled-native-tools",
]);

// Post-bootstrap RLS tables that are global and read-only for `stella`
// (like the other case_law_* tables, which predate the bootstrap). These
// correctly grant stella SELECT only, not full DML.
const POST_BOOTSTRAP_SELECT_ONLY_TABLES = new Set([
  "case_law_index_jobs",
  "legislation_sources",
  "legislation_documents",
  "legislation_search_documents",
  "legislation_index_jobs",
]);

// Post-bootstrap control-plane auth tables that deny `stella` entirely
// (deny-all RLS policy + REVOKE ALL, like `oauth_client`). They
// deliberately grant stella nothing, so the grant requirement does not
// apply. Their migration must REVOKE ALL from stella instead.
const POST_BOOTSTRAP_DENY_STELLA_TABLES = new Set([
  "agent_registration",
  "agent_trusted_issuer",
  "agent_delegation",
  "agent_assertion_replay",
]);

const SQL_IDENTIFIER_PATTERN =
  /"(?<quoted>[^"]+)"|(?<unquoted>[a-z_][a-z0-9_]*)/giu;

type RlsTableIntroduction = {
  migration: string;
  table: string;
};

const identifierNamesFromSql = (sqlList: string): string[] =>
  [...sqlList.matchAll(SQL_IDENTIFIER_PATTERN)].map((match) => {
    if (match.groups?.["quoted"] !== undefined) {
      return match.groups["quoted"];
    }

    return match.groups?.["unquoted"]?.toLowerCase() ?? "";
  });

const tableNameFromSql = (sqlTarget: string): string | null =>
  identifierNamesFromSql(sqlTarget)
    .toReversed()
    .find((name) => name !== "public") ?? null;

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

const isStellaIdentifier = (value: string): boolean =>
  value.trim().toLowerCase() === "stella" ||
  value.trim().toLowerCase() === '"stella"';

const migrationSqlFiles = () =>
  readdirSync(DRIZZLE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => nodePath.resolve(DRIZZLE_DIR, entry.name, "migration.sql"))
    .filter((path) => existsSync(path))
    .toSorted();

const enableRlsTableName = (statement: string): string | null => {
  const prefix = "ALTER TABLE ";
  const suffix = " ENABLE ROW LEVEL SECURITY";
  const upperStatement = statement.toUpperCase();

  if (!upperStatement.startsWith(prefix) || !upperStatement.endsWith(suffix)) {
    return null;
  }

  return tableNameFromSql(statement.slice(prefix.length, -suffix.length));
};

const explicitStellaGrantTables = (statement: string): string[] => {
  const prefix = "GRANT ";
  const onTableMarker = " ON TABLE ";
  const toMarker = " TO ";
  const upperStatement = statement.toUpperCase();

  if (!upperStatement.startsWith(prefix)) {
    return [];
  }

  const onTableIndex = upperStatement.indexOf(onTableMarker);
  const toIndex = upperStatement.lastIndexOf(toMarker);
  if (onTableIndex === -1 || toIndex <= onTableIndex) {
    return [];
  }

  const privilegesSql = statement.slice(prefix.length, onTableIndex);
  const tablesSql = statement.slice(
    onTableIndex + onTableMarker.length,
    toIndex,
  );
  const targetRoleSql = statement.slice(toIndex + toMarker.length);

  if (!isStellaIdentifier(targetRoleSql)) {
    return [];
  }

  const privileges = new Set(identifierNamesFromSql(privilegesSql));
  const grantsTableDml =
    privileges.has("select") &&
    privileges.has("insert") &&
    privileges.has("update") &&
    privileges.has("delete");

  const tables = identifierNamesFromSql(tablesSql).filter(
    (name) => name !== "public",
  );

  // Normal post-bootstrap tables must grant stella full DML; explicit
  // read-only global tables only need SELECT.
  return tables.filter((table) =>
    POST_BOOTSTRAP_SELECT_ONLY_TABLES.has(table)
      ? privileges.has("select")
      : grantsTableDml,
  );
};

const collectRlsGrantState = () => {
  const rlsTables: RlsTableIntroduction[] = [];
  const explicitGrantMigrationsByTable = new Map<string, string[]>();

  for (const path of migrationSqlFiles()) {
    const migration = nodePath.basename(nodePath.resolve(path, ".."));
    const statements = sqlStatements(readFileSync(path, "utf-8"));

    for (const statement of statements) {
      const rlsTable = enableRlsTableName(statement);
      if (
        rlsTable &&
        migration !== BOOTSTRAP_MIGRATION &&
        !BOOTSTRAP_COVERED_RLS_MIGRATIONS.has(migration) &&
        !POST_BOOTSTRAP_DENY_STELLA_TABLES.has(rlsTable)
      ) {
        rlsTables.push({ migration, table: rlsTable });
      }

      for (const table of explicitStellaGrantTables(statement)) {
        const migrations = explicitGrantMigrationsByTable.get(table) ?? [];
        migrations.push(migration);
        explicitGrantMigrationsByTable.set(table, migrations);
      }
    }
  }

  return { explicitGrantMigrationsByTable, rlsTables };
};

describe("RLS table grants", () => {
  test("post-bootstrap RLS tables explicitly grant stella table privileges", () => {
    const { explicitGrantMigrationsByTable, rlsTables } =
      collectRlsGrantState();

    const missingGrants = rlsTables
      .filter(
        ({ migration, table }) =>
          !explicitGrantMigrationsByTable
            .get(table)
            ?.some((grantMigration) => grantMigration >= migration),
      )
      .map(({ migration, table }) => `${migration}: ${table}`);

    expect(missingGrants).toEqual([]);
  });

  test("deny-stella control-plane tables revoke all privileges from stella", () => {
    const revokedTables = new Set<string>();

    for (const path of migrationSqlFiles()) {
      for (const statement of sqlStatements(readFileSync(path, "utf-8"))) {
        const upper = statement.toUpperCase();
        if (!upper.startsWith("REVOKE ALL PRIVILEGES ON TABLE ")) {
          continue;
        }
        if (!upper.endsWith(" FROM STELLA")) {
          continue;
        }
        const tablesSql = statement.slice(
          "REVOKE ALL PRIVILEGES ON TABLE ".length,
          -" FROM stella".length,
        );
        for (const table of identifierNamesFromSql(tablesSql)) {
          revokedTables.add(table);
        }
      }
    }

    for (const table of POST_BOOTSTRAP_DENY_STELLA_TABLES) {
      expect(revokedTables.has(table)).toBe(true);
    }
  });
});
