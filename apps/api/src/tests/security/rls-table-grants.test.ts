import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

const DRIZZLE_DIR = nodePath.resolve(import.meta.dir, "../../../drizzle");
const BOOTSTRAP_MIGRATION = "20260510140000_document_rls_role_bootstrap";

// Deployed migrations contain these six reviewed dynamic grants. New grants
// must be literal SQL so the privilege parser below can classify their target;
// an exact site allowlist prevents EXECUTE format(...) from becoming a bypass.
const AUDITED_DYNAMIC_GRANT_SITES = new Set([
  "20260510140000_document_rls_role_bootstrap: EXECUTE format( 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %s TO stella', target_table )",
  "20260510140000_document_rls_role_bootstrap: EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO stella', target_sequence)",
  "20260510140000_document_rls_role_bootstrap: EXECUTE format('GRANT stella TO %I', CURRENT_USER)",
  "20260516000000_case_law_ingestion_role: EXECUTE format( 'GRANT USAGE, SELECT ON SEQUENCE %s TO stella_ingestion', target_sequence )",
  "20260516000000_case_law_ingestion_role: EXECUTE format('GRANT stella_ingestion TO %I', CURRENT_USER)",
  "20260808014000_legal_lists: EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO stella', table_name)",
]);

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

// Post-bootstrap RLS tables that are read-only for `stella`. Global legal-data
// tables and derived preview passages are maintained by privileged background
// writers, so the request role correctly receives SELECT only, not full DML.
const POST_BOOTSTRAP_SELECT_ONLY_TABLES = new Set([
  // History written only by the record_agent_skill_revision trigger.
  "agent_skill_revisions",
  "search_document_preview_passages",
  "contact_search_document_preview_passages",
  "workspace_search_document_preview_passages",
  "chat_thread_search_preview_passages",
  "case_law_search_document_preview_passages",
  "case_law_index_jobs",
  "case_law_corpus_index_backfills",
  "case_law_corpus_index_source_reconciliations",
  "case_law_corpus_index_writer_leases",
  "case_law_corpus_index_projections",
  // Exact corpus-index accounting is maintained only by ingestion triggers
  // and the bounded seed worker; request handlers may observe its status.
  "case_law_corpus_index_counts",
  "case_law_corpus_index_count_backfills",
  // Append-only ingestion registry: request code reads the bounded country
  // set for census; decision-write triggers are its only writer.
  "case_law_corpus_jurisdictions",
  "case_law_corpus_index_delete_watermarks",
  "legislation_sources",
  "legislation_documents",
  "legislation_search_documents",
  "legislation_index_jobs",
  "legislation_corpus_index_delete_watermarks",
  // Crawl bookkeeping: the app role reads coverage for reporting, only
  // ingestion writes it.
  "case_law_coverage_slices",
  // Listed decisions the reconciliation could not ingest. Same shape as the
  // coverage ledger it sits beside: read by the ingestion status rollup,
  // written only by the reconciliation loop.
  "case_law_reconciliation_items",
  // Where the citation-resolution walk had got to. Operational progress the
  // status rollup reads; only the resolution loop advances it.
  "case_law_citation_resolution_progress",
  // Dormant compatibility tables retained until the rolling-deploy and
  // rollback window closes; their existing migration grants SELECT only.
  "case_law_citation_resolution_census_runs",
  "case_law_citation_resolution_census",
  // Provision references extracted from decision text: global legal data read
  // by the public case-law reads, written only by the extraction loop.
  "case_law_provision_citations",
  // Publisher-stated decision identifiers: global legal data read by public
  // case-law projections, written only by ingestion and the bounded backfill.
  "case_law_decision_identifiers",
  // Durable operator progress: request code may inspect the rollout receipt;
  // only the ingestion role and the maintenance script may advance it.
  "case_law_decision_identifier_backfills",
  // Corpus-index generation identity is immutable control-plane state. The
  // request role resolves serving generations but never mutates the registry.
  "corpus_index_generations",
  // Mutation revisions are appended and pruned only by ingestion triggers;
  // request code may read the current proof watermark.
  "corpus_index_projection_revisions",
  // Final-generation desired/applied state and append intents are durable
  // control-plane records. Request handlers may observe them; ingestion alone
  // mutates the state machine.
  "corpus_index_projection_states",
  "corpus_index_projection_intents",
]);

// Internal handoff tables whose scoped role needs INSERT but not table-wide
// SELECT. Privileged workers own reads; a table may additionally grant a
// narrowly scoped transition such as deleting an exact cleanup tombstone.
const POST_BOOTSTRAP_SCOPED_HANDOFF_TABLES = new Set([
  "buffer_object_cleanup_intents",
  "entity_deletion_cleanup_requests",
  "template_deletion_cleanup_requests",
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
  // Better Auth OAuth control-plane state. Request-role access would expose
  // resource policy or let tenant traffic change token authorization rules.
  "oauth_resource",
  "oauth_client_resource",
  "oauth_client_assertion",
  // Machine API keys: credential digests plus the permission set each key
  // carries. A tenant-scoped connection must be able to neither read a digest
  // nor widen a key's permissions, so every access goes through better-auth on
  // the owner connection.
  "apikey",
  "case_law_corpus_upload_intents",
  "case_law_corpus_index_pending_deletes",
  "legislation_corpus_index_pending_deletes",
  // Internal ingestion coordination: publisher aliases are reserved before
  // decision writes and must never be queried through the request role.
  "case_law_decision_source_identities",
  "account_deletion_effect_chunks",
  "entity_deletion_effect_chunks",
]);

const SQL_IDENTIFIER_PATTERN =
  /"(?<quoted>[^"]+)"|(?<unquoted>[a-z_][a-z0-9_]*)/giu;
const DYNAMIC_GRANT_PATTERN = /\bEXECUTE\b[^;]*\bGRANT\b[^;]*/giu;

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

type DynamicGrantSitesOptions = {
  contents: string;
  migration: string;
};

const dynamicGrantSites = ({
  contents,
  migration,
}: DynamicGrantSitesOptions): string[] => {
  const uncommented = stripSqlLineComments(contents);
  return [...uncommented.matchAll(DYNAMIC_GRANT_PATTERN)].map(
    (match) => `${migration}: ${match[0].replace(/\s+/gu, " ").trim()}`,
  );
};

type GrantsRequiredPrivilegesOptions = {
  table: string;
  privileges: Set<string>;
  grantsTableDml: boolean;
};

const TABLE_MUTATION_PRIVILEGES = new Set([
  "all",
  "delete",
  "insert",
  "maintain",
  "references",
  "trigger",
  "truncate",
  "update",
]);
const STELLA_GRANT_GRANTEES = new Set(["public", "stella"]);

const grantsRequiredPrivileges = ({
  table,
  privileges,
  grantsTableDml,
}: GrantsRequiredPrivilegesOptions): boolean => {
  if (POST_BOOTSTRAP_SELECT_ONLY_TABLES.has(table)) {
    return (
      privileges.has("select") &&
      privileges.isDisjointFrom(TABLE_MUTATION_PRIVILEGES)
    );
  }
  if (POST_BOOTSTRAP_SCOPED_HANDOFF_TABLES.has(table)) {
    return privileges.has("insert");
  }
  return grantsTableDml;
};

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

type StellaTableGrant =
  | {
      type: "tables";
      privileges: Set<string>;
      tables: string[];
    }
  | {
      type: "all_tables_in_schema";
      privileges: Set<string>;
      schemas: string[];
    };

type SqlKeywordIndexOptions = {
  from?: number;
  keyword: string;
  sql: string;
};

const ASCII_LOWERCASE_A = 97;
const ASCII_LOWERCASE_Z = 122;
const ASCII_CASE_OFFSET = 32;

const asciiUpperCode = (code: number): number =>
  code >= ASCII_LOWERCASE_A && code <= ASCII_LOWERCASE_Z
    ? code - ASCII_CASE_OFFSET
    : code;

const startsWithSqlKeyword = (
  sql: string,
  keyword: string,
  index: number,
): boolean => {
  for (let offset = 0; offset < keyword.length; offset += 1) {
    const sqlCode = sql.codePointAt(index + offset);
    if (
      sqlCode === undefined ||
      asciiUpperCode(sqlCode) !== keyword.codePointAt(offset)
    ) {
      return false;
    }
  }
  return true;
};

/** Locate structural SQL outside double-quoted identifiers. */
const sqlKeywordIndex = ({
  from = 0,
  keyword,
  sql,
}: SqlKeywordIndexOptions): number => {
  let quoted = false;

  for (let index = 0; index <= sql.length - keyword.length; index += 1) {
    if (sql.at(index) === '"') {
      if (quoted && sql.at(index + 1) === '"') {
        index += 1;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (!quoted && index >= from && startsWithSqlKeyword(sql, keyword, index)) {
      return index;
    }
  }
  return -1;
};

const grantTargetsStella = (targetClause: string): boolean => {
  const optionsStart = [" WITH GRANT OPTION", " GRANTED BY "]
    .map((keyword) => sqlKeywordIndex({ keyword, sql: targetClause }))
    .filter((index) => index !== -1)
    .toSorted((left, right) => left - right)
    .at(0);
  const granteesSql =
    optionsStart === undefined
      ? targetClause
      : targetClause.slice(0, optionsStart);
  return identifierNamesFromSql(granteesSql).some((grantee) =>
    STELLA_GRANT_GRANTEES.has(grantee.toLowerCase()),
  );
};

const stellaTableGrant = (statement: string): StellaTableGrant | null => {
  const prefix = "GRANT ";
  const onMarker = " ON ";
  const tableMarker = "TABLE ";
  const toMarker = " TO ";
  const upperStatement = statement.toUpperCase();

  if (!upperStatement.startsWith(prefix)) {
    return null;
  }

  const onIndex = sqlKeywordIndex({
    keyword: onMarker,
    sql: statement,
  });
  if (onIndex === -1) {
    return null;
  }
  const targetStart = onIndex + onMarker.length;
  const tablesStart = startsWithSqlKeyword(statement, tableMarker, targetStart)
    ? targetStart + tableMarker.length
    : targetStart;
  const toIndex = sqlKeywordIndex({
    from: tablesStart,
    keyword: toMarker,
    sql: statement,
  });
  if (toIndex <= onIndex) {
    return null;
  }

  const privilegesSql = statement.slice(prefix.length, onIndex);
  const tablesSql = statement.slice(tablesStart, toIndex);
  const targetRoleSql = statement.slice(toIndex + toMarker.length);

  if (!grantTargetsStella(targetRoleSql)) {
    return null;
  }

  const privileges = new Set(identifierNamesFromSql(privilegesSql));
  const allTablesPrefix = "ALL TABLES IN SCHEMA ";
  if (startsWithSqlKeyword(tablesSql, allTablesPrefix, 0)) {
    return {
      type: "all_tables_in_schema",
      privileges,
      schemas: identifierNamesFromSql(tablesSql.slice(allTablesPrefix.length)),
    };
  }
  const tables = identifierNamesFromSql(tablesSql).filter(
    (name) => name !== "public",
  );

  return { type: "tables", privileges, tables };
};

const explicitStellaGrantTables = (statement: string): string[] => {
  const grant = stellaTableGrant(statement);
  if (grant?.type !== "tables") {
    return [];
  }
  const grantsTableDml =
    grant.privileges.has("select") &&
    grant.privileges.has("insert") &&
    grant.privileges.has("update") &&
    grant.privileges.has("delete");

  // Normal post-bootstrap tables grant full DML; explicit internal categories
  // enforce their narrower request-role surface.
  return grant.tables.filter((table) =>
    grantsRequiredPrivileges({
      table,
      privileges: grant.privileges,
      grantsTableDml,
    }),
  );
};

const selectOnlyMutationTargets = (grant: StellaTableGrant): string[] => {
  if (grant.privileges.isDisjointFrom(TABLE_MUTATION_PRIVILEGES)) {
    return [];
  }
  if (grant.type === "all_tables_in_schema") {
    if (!grant.schemas.includes("public")) {
      return [];
    }
    return ["all tables in schema public"];
  }
  return grant.tables.filter((table) =>
    POST_BOOTSTRAP_SELECT_ONLY_TABLES.has(table),
  );
};

const collectRlsGrantState = () => {
  const rlsTables: RlsTableIntroduction[] = [];
  const explicitGrantMigrationsByTable = new Map<string, string[]>();
  const selectOnlyMutationGrants: string[] = [];
  const unexpectedDynamicGrantSites: string[] = [];

  for (const path of migrationSqlFiles()) {
    const migration = nodePath.basename(nodePath.resolve(path, ".."));
    const contents = readFileSync(path, "utf-8");
    const statements = sqlStatements(contents);

    for (const site of dynamicGrantSites({ contents, migration })) {
      if (!AUDITED_DYNAMIC_GRANT_SITES.has(site)) {
        unexpectedDynamicGrantSites.push(site);
      }
    }

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

      const grant = stellaTableGrant(statement);
      if (grant === null) {
        continue;
      }
      for (const target of selectOnlyMutationTargets(grant)) {
        selectOnlyMutationGrants.push(`${migration}: ${target}`);
      }
    }
  }

  return {
    explicitGrantMigrationsByTable,
    rlsTables,
    selectOnlyMutationGrants,
    unexpectedDynamicGrantSites,
  };
};

describe("RLS table grants", () => {
  test("rejects dynamic grants outside the exact deployed allowlist", () => {
    expect(
      dynamicGrantSites({
        contents:
          "EXECUTE format($grant$GRANT UPDATE ON TABLE %I TO stella$grant$, table_name);",
        migration: "future_migration",
      }),
    ).toEqual([
      "future_migration: EXECUTE format($grant$GRANT UPDATE ON TABLE %I TO stella$grant$, table_name)",
    ]);
    expect(
      dynamicGrantSites({
        contents:
          "EXECUTE 'GRANT UPDATE ON TABLE case_law_corpus_index_counts TO stella';",
        migration: "future_migration",
      }),
    ).toEqual([
      "future_migration: EXECUTE 'GRANT UPDATE ON TABLE case_law_corpus_index_counts TO stella'",
    ]);
    expect(collectRlsGrantState().unexpectedDynamicGrantSites).toEqual([]);
  });

  test("classifies stella in a grantee list but not as the grantor", () => {
    expect(
      stellaTableGrant(
        "GRANT SELECT, UPDATE ON TABLE classified_table TO stella, another_role WITH GRANT OPTION",
      ),
    ).toEqual({
      type: "tables",
      privileges: new Set(["select", "update"]),
      tables: ["classified_table"],
    });
    expect(
      stellaTableGrant(
        'GRANT SELECT, UPDATE ON TABLE classified_table TO stella, "read TO audit", "read WITH GRANT OPTION audit" GRANTED BY owner',
      ),
    ).toEqual({
      type: "tables",
      privileges: new Set(["select", "update"]),
      tables: ["classified_table"],
    });
    expect(
      stellaTableGrant(
        'GRANT SELECT, UPDATE ON TABLE classified_table, "straße" TO stella',
      ),
    ).toEqual({
      type: "tables",
      privileges: new Set(["select", "update"]),
      tables: ["classified_table", "straße"],
    });
    expect(
      stellaTableGrant("GRANT SELECT, UPDATE ON classified_table TO PUBLIC"),
    ).toEqual({
      type: "tables",
      privileges: new Set(["select", "update"]),
      tables: ["classified_table"],
    });
    expect(
      stellaTableGrant(
        "GRANT SELECT ON TABLE classified_table TO another_role GRANTED BY stella",
      ),
    ).toBeNull();
    const schemaWideMutation = stellaTableGrant(
      "GRANT UPDATE ON ALL TABLES IN SCHEMA public TO PUBLIC",
    );
    expect(schemaWideMutation).toEqual({
      type: "all_tables_in_schema",
      privileges: new Set(["update"]),
      schemas: ["public"],
    });
    if (schemaWideMutation !== null) {
      expect(selectOnlyMutationTargets(schemaWideMutation)).toEqual([
        "all tables in schema public",
      ]);
    }
  });

  test("SELECT-only tables never grant mutation privileges to stella", () => {
    expect(collectRlsGrantState().selectOnlyMutationGrants).toEqual([]);
  });

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
