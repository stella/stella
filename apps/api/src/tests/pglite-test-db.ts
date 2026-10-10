import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { getTableName, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as agentAuthSchema from "@/api/db/agent-auth-schema";
import * as authSchema from "@/api/db/auth-schema";
import * as rlsExports from "@/api/db/rls";
import * as schema from "@/api/db/schema";
import type { AnyDrizzle } from "@/api/db/scoped";
import {
  PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION,
  ROLLOUT_CASE_LAW_SOURCE_COLUMNS,
  ROLLOUT_CASE_LAW_SOURCE_RELATION,
  ROLLOUT_CASE_LAW_WHOLE_RELATIONS,
} from "@/api/lib/public-law-relations";
import {
  createSchemaPglite,
  installPgliteDecisionAliases,
  installPgliteDesktopPresenceRls,
  installPgliteFlowTransitions,
  installPgliteChatRunLogRls,
  installPgliteChatTurnRunIdLookup,
  installPgliteAgentSkillRevisionTrigger,
  installPgliteCaseLawObservationFence,
  installPgliteCorpusProjectionRevisionFence,
  installPgliteLegislationExpressionIdentity,
  installPgliteLegislationPayloadRevision,
  installPgliteProvisionExtractionState,
  installPgliteSchedulerJobPauseLog,
  installPgliteOrganizationMemberCapacity,
  installPgliteWorkspaceContactCapacity,
  installPgliteListVerificationBudgets,
  installPglitePdfSigningTokenScopes,
  installPglitePlaybookDocumentTypeKey,
  installPgliteSchemaPrerequisites,
  installPgliteEntityFeatureGateMaintenance,
  readPglitePublicSanctionsGrants,
  installPgliteStatuteCitationCounts,
  installPgliteTimeEntryTimerSignals,
  installPgliteSanctionsMonitoringTriggers,
  installPgliteTreeParentGuards,
  installPgliteWorkspaceAccessObjects,
} from "@/api/tests/pglite-schema";
import {
  deriveStellaTablePrivileges,
  readCommittedMigrations,
  stellaTablePrivilegeStatements,
} from "@/api/tests/stella-table-privileges";

// Test processes boot from a prebuilt data-dir snapshot when the batching
// runner provides one (scripts/run-tests.ts). Building the schema in-process
// costs a ~2.2 GB peak (drizzle-kit's push diffing plus PGlite WASM churn);
// loading a snapshot skips drizzle-kit entirely and keeps the process near
// PGlite's runtime floor.
export const PGLITE_TEST_SNAPSHOT_ENV = "PGLITE_TEST_SNAPSHOT";

const allSchema = {
  ...schema,
  ...authSchema,
  ...agentAuthSchema,
  ...rlsExports,
};

const quoteSqlIdentifier = (identifier: string) =>
  `"${identifier.replaceAll('"', '""')}"`;

/**
 * Exact columns the decision-analysis operator role may read, and the single
 * column it may write. The migration owns these grants in production; the
 * privilege test folds that SQL back against this map so the two cannot drift.
 */
export const CASE_LAW_ANALYSIS_WRITER_SELECT_COLUMNS = {
  case_law_decisions: [
    "id",
    "source_id",
    "language",
    "court",
    "country",
    "decision_type",
    "document_ast",
    "ast_s3_key",
    "content_hash",
    "analysis",
    "redacted_at",
    "metadata",
    "citation_authority",
    "citation_count",
  ],
  case_law_sources: ["id", "descriptor"],
  case_law_corpus_tombstones: ["location"],
} as const;

/**
 * `updated_at` is writable only because it rides every write: the column
 * carries `$onUpdate`, so the ORM assigns it in the same statement that sets
 * `analysis`, and a statement touching an ungranted column is refused whole.
 */
export const CASE_LAW_ANALYSIS_WRITER_UPDATE_COLUMNS = {
  case_law_decisions: ["analysis", "updated_at"],
} as const;

/**
 * Exact columns the internal case-law analysis reader may read. The migration
 * owns these grants in production; the privilege test folds that SQL back
 * against this map so the two cannot drift.
 */
export const CASE_LAW_ANALYSIS_READER_SELECT_COLUMNS = {
  case_law_citations: [
    "id",
    "citing_decision_id",
    "cited_decision_id",
    "citation_text",
    "section_index",
    "polarity",
    "polarity_rule_id",
    "kind",
  ],
  case_law_decisions: [
    "id",
    "case_number",
    "court",
    "decision_date",
    "country",
    "language",
    "citation_authority",
    "sections",
    "text_s3_key",
    "normalized_s3_key",
  ],
  case_law_polarity_rules: [
    "id",
    "language",
    "polarity",
    "pattern",
    "match_count",
    "source",
  ],
  case_law_court_weights: ["country", "court_pattern", "tier"],
  case_law_court_directory_ranks: ["country", "court_id", "tier", "weight"],
  case_law_corpus_tombstones: ["location"],
} as const;

/**
 * Exact columns the internal corpus sample reader may read. The migration owns
 * these grants in production; the privilege test folds that SQL back against
 * this map so the two cannot drift.
 */
export const CORPUS_SAMPLE_READER_SELECT_COLUMNS = {
  case_law_citations: [
    "id",
    "citing_decision_id",
    "cited_decision_id",
    "citation_text",
    "section_index",
    "polarity",
    "kind",
  ],
  case_law_corpus_tombstones: ["location"],
  case_law_decisions: [
    "id",
    "case_number",
    "ecli",
    "court",
    "country",
    "decision_date",
    "decision_type",
    "fulltext",
    "document_ast",
    "source_url",
    "document_url",
    "metadata",
    "redacted_at",
    "text_s3_key",
    "ast_s3_key",
  ],
  legislation_documents: [
    "id",
    "source_id",
    "eli",
    "title",
    "country",
    "language",
    "document_type",
    "status",
    "effective_date",
    "version_valid_from",
    "version_valid_to",
    "fulltext",
    "source_url",
    "document_url",
    "metadata",
    "text_s3_key",
    "expression_kind",
    "window_disposition",
    "window_disposition_basis",
  ],
  legislation_sources: ["id", "adapter_key"],
} as const;

/**
 * Every column of `case_law_sources` the ingestion role may write. The table
 * is otherwise migration-managed, so the role holds UPDATE column by column
 * and each column here matches a grant in a committed migration
 * (`pglite-role-grants.test.ts` holds the two to agreement).
 *
 * One list, used to write the GRANT and to state what the role ends up with:
 * a second hand-kept copy is how `stored_total` reached production with a
 * reader grant and no writer.
 */
export const CASE_LAW_SOURCE_INGESTION_UPDATE_COLUMNS = [
  "sync_cursor",
  "last_sync_at",
  "updated_at",
  "observation_order",
  "checkpoint_observation_order",
  "ingestion_lease_token",
  "ingestion_lease_expires_at",
  "ingestion_lease_purpose",
  "decision_merge_epoch",
  "reported_total",
  "reported_total_as_of",
  "reported_total_origin",
  "stored_total",
  "stored_total_as_of",
  "stored_total_attempted_at",
  "stored_total_next_refresh_at",
  "stored_total_held_since",
  "stored_total_warned_slot",
] as const;

/**
 * Execute a read callback under the same role used by the external public-law
 * database. Writes in the surrounding test setup stay on the owner handle;
 * this role change is local to the callback's transaction.
 */
type PublicLawRoleTransaction = {
  execute: (query: SQLWrapper | string) => PromiseLike<unknown>;
};

export const withPublicLawReaderRole = async <
  TTransaction extends PublicLawRoleTransaction,
  TResult,
>(
  database: AnyDrizzle<TTransaction>,
  fn: (tx: TTransaction) => Promise<TResult>,
): Promise<TResult> =>
  await database.transaction(async (tx) => {
    await tx.execute(
      sql.raw(
        `SET LOCAL ROLE ${quoteSqlIdentifier(rlsExports.stellaPublicLawReader.name)}`,
      ),
    );
    return await fn(tx);
  });

const AUTH_USER_STELLA_SELECT_COLUMNS_SQL =
  authSchema.AUTH_USER_STELLA_SELECT_COLUMN_NAMES.map(quoteSqlIdentifier).join(
    ", ",
  );

const CORPUS_PROJECTION_HISTORY_TABLES_SQL = [
  schema.corpusIndexProjectionIntents,
  schema.corpusIndexProjectionStates,
]
  .map(getTableName)
  .map(quoteSqlIdentifier)
  .join(", ");

const CORPUS_PROJECTION_REVISION_TABLE_SQL = quoteSqlIdentifier(
  getTableName(schema.corpusIndexProjectionRevisions),
);

// The snapshot bakes in the superset every suite needs: RLS roles, schema,
// workspace-access objects, and the role grants. Suites that never SET ROLE
// simply ignore the grants.
/**
 * Reader columns this release declares `permitted` but no migration grants
 * yet: the grant lands in a later release, so running readers accept it. The
 * harness mirrors the migrations, so it leaves them ungranted too.
 */
const PUBLIC_LAW_COLUMNS_GRANTED_IN_A_LATER_RELEASE: ReadonlySet<string> =
  new Set(["case_law_decisions.docket_family_key"]);

/**
 * Role grants the harness runs after `stella`'s table privileges are set from
 * the migrations (`applyStellaTablePrivileges`). Table-level privileges of
 * `stella` are not spelled here: the migrations own them, and a second copy
 * is how a REVOKE goes missing from the harness.
 */
export const ROLE_GRANT_STATEMENTS = [
  `GRANT SELECT ON TABLE "soft_law_sources", "soft_law_documents", "soft_law_document_versions", "soft_law_document_locators", "soft_law_ingestion_attempts" TO stella_ingestion`,
  `GRANT INSERT, UPDATE ON TABLE "soft_law_documents", "soft_law_document_versions", "soft_law_document_locators", "soft_law_ingestion_attempts" TO stella_ingestion`,
  `GRANT UPDATE (listing_baseline, listing_seen, listing_expected_total, sync_cursor, last_sync_at, run_state, run_id, run_started_at, lease_token, lease_expires_at, failure_tag) ON TABLE "soft_law_sources" TO stella_ingestion`,
  `GRANT SELECT, INSERT, UPDATE ON TABLE "case_law_decision_aliases" TO stella_ingestion`,
  `
    GRANT SELECT (${AUTH_USER_STELLA_SELECT_COLUMNS_SQL})
      ON TABLE "user" TO stella
  `,
  `
    GRANT UPDATE (last_active_workspace_id) ON TABLE "member" TO stella
  `,
  // Exact-key cleanup intents: the request role reaches only the id, the
  // state and the retry schedule.
  `
    GRANT SELECT ("id", "status") ON TABLE "buffer_object_cleanup_intents"
      TO stella
  `,
  `
    GRANT UPDATE ("status", "attempt_count", "next_attempt_at")
      ON TABLE "buffer_object_cleanup_intents" TO stella
  `,
  // List item provenance is frozen apart from its verification fields.
  `
    GRANT UPDATE ("verification_status", "verified_by", "verified_at", "updated_at")
      ON TABLE "legal_list_item_sources" TO stella
  `,
  `
    GRANT SELECT ON TABLE
      "case_law_sources",
      "case_law_decisions",
      "case_law_decision_identifiers",
      "case_law_decision_identifier_backfills",
      "case_law_judges",
      "case_law_decision_judges",
      "case_law_citations",
      "case_law_provision_citations",
      "case_law_statute_citation_memberships",
      "case_law_statute_citation_counts",
      "case_law_statute_citation_count_state",
      "case_law_polarity_rules",
      "case_law_court_weights",
      "case_law_court_directory_ranks",
      "case_law_fts_configs",
      "case_law_search_documents",
      "case_law_ingestion_events",
      "case_law_ingestion_failures",
      "case_law_index_jobs",
      "case_law_citation_reviews"
    TO stella_ingestion
  `,
  `
    GRANT INSERT, UPDATE, DELETE ON TABLE
      "case_law_decisions",
      "case_law_decision_identifiers",
      "case_law_decision_identifier_backfills",
      "case_law_judges",
      "case_law_decision_judges",
      "case_law_citations",
      "case_law_provision_citations",
      "case_law_statute_citation_memberships",
      "case_law_statute_citation_counts",
      "case_law_polarity_rules",
      "case_law_court_weights",
      "case_law_court_directory_ranks",
      "case_law_fts_configs",
      "case_law_search_documents",
      "case_law_ingestion_events",
      "case_law_ingestion_failures"
    TO stella_ingestion
  `,
  `
    GRANT UPDATE ON TABLE "case_law_statute_citation_count_state"
      TO stella_ingestion
  `,
  `
    GRANT UPDATE (${CASE_LAW_SOURCE_INGESTION_UPDATE_COLUMNS.join(", ")})
      ON TABLE "case_law_sources"
      TO stella_ingestion
  `,
  `
    GRANT MAINTAIN ON TABLE "case_law_sources" TO stella_ingestion
  `,
  // Ingestion-owned case-law tables the migrations grant one by one, as they
  // were added. `pglite-role-grants.test.ts` holds this list and the
  // migrations to agreement, so the next such table cannot be forgotten here.
  `
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      "case_law_reconciliation_items",
      "case_law_search_backfill_failures",
      "case_law_coverage_slices",
      "case_law_corpus_upload_intents",
      "case_law_corpus_pack_refs",
      "case_law_corpus_tombstones",
      "case_law_decision_source_identities",
      "case_law_decision_supplements",
      "case_law_search_document_preview_passages",
      "case_law_citation_resolution_census",
      "case_law_citation_resolution_census_runs",
      "case_law_citation_resolution_progress",
      "case_law_raw_sweeps",
      "case_law_citation_authority_sweep"
    TO stella_ingestion
  `,
  `
    GRANT SELECT, INSERT ON TABLE "case_law_corpus_jurisdictions"
    TO stella_ingestion
  `,
  // Provision extraction state: request code reads it and ingestion updates
  // it; only owner-run database functions insert state or read scopes.
  `
    GRANT SELECT, UPDATE ON TABLE "case_law_provision_extractions"
    TO stella_ingestion
  `,
  `
    GRANT SELECT ON TABLE
      "case_law_provision_scope_transitions",
      "case_law_provision_extraction_revisions_registry",
      "case_law_provision_extraction_revisions"
    TO stella_ingestion
  `,
  // case_law_index_jobs is append-only: ingestion appends audit rows
  // but never updates or deletes them.
  `
    GRANT INSERT ON TABLE "case_law_index_jobs" TO stella_ingestion
  `,
  // Global sanctions lists are readable by requests and writable by ingestion.
  `
    REVOKE INSERT, UPDATE, DELETE ON TABLE
      "sanctions_sources", "sanctions_editions", "sanctions_edition_fanouts",
      "sanctions_entry_payloads", "sanctions_edition_entries"
    FROM stella
  `,
  `
    GRANT SELECT, INSERT, UPDATE ON TABLE
      "sanctions_sources", "sanctions_editions", "sanctions_edition_fanouts"
    TO stella_ingestion
  `,
  `
    GRANT SELECT, INSERT ON TABLE
      "sanctions_entry_payloads", "sanctions_edition_entries"
    TO stella_ingestion
  `,
  // Legislation corpus — same global model as case law.
  `
    GRANT SELECT ON TABLE
      "legislation_sources",
      "legislation_documents",
      "legislation_search_documents",
      "legislation_index_jobs"
    TO stella_ingestion
  `,
  `
    GRANT INSERT, UPDATE, DELETE ON TABLE
      "legislation_documents",
      "legislation_search_documents"
    TO stella_ingestion
  `,
  `
    GRANT UPDATE (sync_cursor, last_sync_at, updated_at)
      ON TABLE "legislation_sources"
      TO stella_ingestion
  `,
  `
    GRANT MAINTAIN ON TABLE "legislation_sources" TO stella_ingestion
  `,
  `
    GRANT INSERT ON TABLE "legislation_index_jobs" TO stella_ingestion
  `,
  // Written only by the legislation triggers, as the legislation writer.
  `
    GRANT INSERT ON TABLE "legislation_work_changes" TO stella_ingestion
  `,
  // Written by legislation ingestion beside each version, read by the
  // public-law reader through the column map below.
  `
    GRANT SELECT, INSERT, DELETE ON TABLE "legislation_work_names"
    TO stella_ingestion
  `,
  // Final-generation state is observable by request code but mutated only by
  // ingestion. A narrowly scoped database function owns retirement deletes.
  `
    GRANT SELECT ON TABLE
      "corpus_index_generations",
      ${CORPUS_PROJECTION_HISTORY_TABLES_SQL},
      ${CORPUS_PROJECTION_REVISION_TABLE_SQL}
    TO stella_ingestion
  `,
  `
    GRANT INSERT, DELETE ON TABLE "corpus_index_generations"
    TO stella_ingestion
  `,
  `
    GRANT UPDATE (status, updated_at)
      ON TABLE "corpus_index_generations" TO stella_ingestion
  `,
  // A group's contract binding is written once; ingestion may insert it and
  // move only its readiness.
  `
    GRANT SELECT, INSERT ON TABLE "corpus_index_group_enrollments"
    TO stella_ingestion
  `,
  `
    GRANT UPDATE (provisioning_status, attested_at, updated_at)
      ON TABLE "corpus_index_group_enrollments" TO stella_ingestion
  `,
  // The withdrawal trail is append-only: ingestion records, the app reads.
  `
    GRANT SELECT, INSERT ON TABLE "corpus_index_group_withdrawals"
    TO stella_ingestion
  `,
  `
    GRANT INSERT, UPDATE ON TABLE
      ${CORPUS_PROJECTION_HISTORY_TABLES_SQL}
    TO stella_ingestion
  `,
  `
    GRANT INSERT, DELETE ON TABLE
      ${CORPUS_PROJECTION_REVISION_TABLE_SQL}
    TO stella_ingestion
  `,
  `
    GRANT USAGE, SELECT ON SEQUENCE
      "corpus_index_projection_revisions_revision_seq" TO stella_ingestion
  `,
  // Preserve the v0.7.22 reader contract until its rollback window closes.
  `
    GRANT USAGE ON SCHEMA public TO stella_caselaw_reader
  `,
  `
    GRANT SELECT ON TABLE ${ROLLOUT_CASE_LAW_WHOLE_RELATIONS.map(quoteSqlIdentifier).join(", ")}
    TO stella_caselaw_reader
  `,
  `
    GRANT SELECT (${ROLLOUT_CASE_LAW_SOURCE_COLUMNS.map(quoteSqlIdentifier).join(", ")})
      ON TABLE ${quoteSqlIdentifier(ROLLOUT_CASE_LAW_SOURCE_RELATION)}
      TO stella_caselaw_reader
  `,
  // Derived from the allowlist the connection validator reads, so the role
  // in tests can only ever match the role the migration defines.
  `
    GRANT USAGE ON SCHEMA public TO stella_public_law_reader
  `,
  // Alias reader grants land only after the release declaring them optional.
  ...Object.entries(PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION)
    .filter(
      ([relation]) => relation !== getTableName(schema.caseLawDecisionAliases),
    )
    .map(
      ([relation, columns]) => `
      GRANT SELECT (${Object.keys(columns)
        .filter(
          (column) =>
            !PUBLIC_LAW_COLUMNS_GRANTED_IN_A_LATER_RELEASE.has(
              `${relation}.${column}`,
            ),
        )
        .map(quoteSqlIdentifier)
        .join(", ")})
        ON TABLE ${quoteSqlIdentifier(relation)}
        TO stella_public_law_reader
    `,
    ),
  ...readPglitePublicSanctionsGrants(),
  // Operator role for pre-computed decision analyses: a narrow read plus the
  // single writable column.
  `
    GRANT USAGE ON SCHEMA public TO stella_case_law_analysis_writer
  `,
  ...Object.entries(CASE_LAW_ANALYSIS_WRITER_SELECT_COLUMNS).map(
    ([relation, columns]) => `
      GRANT SELECT (${columns.map(quoteSqlIdentifier).join(", ")})
        ON TABLE ${quoteSqlIdentifier(relation)}
        TO stella_case_law_analysis_writer
    `,
  ),
  ...Object.entries(CASE_LAW_ANALYSIS_WRITER_UPDATE_COLUMNS).map(
    ([relation, columns]) => `
      GRANT UPDATE (${columns.map(quoteSqlIdentifier).join(", ")})
        ON TABLE ${quoteSqlIdentifier(relation)}
        TO stella_case_law_analysis_writer
    `,
  ),
  `
    GRANT USAGE ON SCHEMA public TO stella_case_law_analysis_reader
  `,
  ...Object.entries(CASE_LAW_ANALYSIS_READER_SELECT_COLUMNS).map(
    ([relation, columns]) => `
      GRANT SELECT (${columns.map(quoteSqlIdentifier).join(", ")})
        ON TABLE ${quoteSqlIdentifier(relation)}
        TO stella_case_law_analysis_reader
    `,
  ),
  `
    GRANT USAGE ON SCHEMA public TO stella_corpus_sample_reader
  `,
  ...Object.entries(CORPUS_SAMPLE_READER_SELECT_COLUMNS).map(
    ([relation, columns]) => `
      GRANT SELECT (${columns.map(quoteSqlIdentifier).join(", ")})
        ON TABLE ${quoteSqlIdentifier(relation)}
        TO stella_corpus_sample_reader
    `,
  ),
] as const;

/**
 * The relations a harness role privilege can reach: tables, partitioned
 * tables, views, materialized views and foreign tables in `public`.
 */
export const HARNESS_RELATIONS_SQL = `
  SELECT c.relname AS relation
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
`;

/**
 * Give `stella` exactly the table privileges the committed migrations leave it
 * with, relation by relation. The column grants in `ROLE_GRANT_STATEMENTS`
 * run afterwards, because revoking a table privilege drops the column grants
 * of the same kind.
 */
const applyStellaTablePrivileges = async (client: PGlite): Promise<void> => {
  const { privileges } = deriveStellaTablePrivileges(readCommittedMigrations());
  const { rows } = await client.query<{ relation: string }>(
    HARNESS_RELATIONS_SQL,
  );
  const statements = rows.flatMap(({ relation }) =>
    stellaTablePrivilegeStatements(
      relation,
      privileges.get(relation) ?? new Set(),
    ),
  );
  await client.exec(statements.join(";\n"));
};

/**
 * Build a fully provisioned test PGlite from scratch: RLS roles, schema
 * prerequisites, the drizzle schema push, workspace-access objects, and
 * role grants. This is the expensive path (drizzle-kit peaks ~2.2 GB);
 * batched runs pay it once in the snapshot builder, solo `bun test` runs
 * pay it per process.
 */
export const buildFullTestPglite = async (): Promise<PGlite> => {
  const client = await createSchemaPglite();
  const db = drizzle({ client });
  const pushSchemaDb = drizzle({ client });

  await db.execute(sql.raw("CREATE ROLE stella NOLOGIN"));
  await db.execute(
    sql.raw(
      "CREATE ROLE stella_entity_gate NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION",
    ),
  );
  await db.execute(sql.raw("CREATE ROLE stella_ingestion NOLOGIN"));
  await db.execute(sql.raw("CREATE ROLE stella_caselaw_reader NOLOGIN"));
  await db.execute(sql.raw("CREATE ROLE stella_public_law_reader NOLOGIN"));
  await db.execute(
    sql.raw("CREATE ROLE stella_public_sanctions_reader NOLOGIN"),
  );
  await db.execute(
    sql.raw("CREATE ROLE stella_case_law_analysis_writer NOLOGIN"),
  );
  await db.execute(
    sql.raw("CREATE ROLE stella_case_law_analysis_reader NOLOGIN"),
  );
  await db.execute(sql.raw("CREATE ROLE stella_corpus_sample_reader NOLOGIN"));
  await installPgliteSchemaPrerequisites(db);

  // drizzle-kit is a heavyweight dev dependency; import it only on this
  // build path so snapshot-booted test processes never load it.
  const { pushSchema } = await import("drizzle-kit/api-postgres");
  const { sqlStatements } = await pushSchema(allSchema, pushSchemaDb);
  for (const statement of sqlStatements) {
    await db.execute(sql.raw(statement));
  }
  await installPgliteFlowTransitions(db);
  await installPgliteWorkspaceAccessObjects(db);
  await db.transaction(async (tx) => {
    await installPgliteEntityFeatureGateMaintenance(tx);
  });
  await installPgliteAgentSkillRevisionTrigger(db);
  await installPgliteDecisionAliases(db);
  await installPgliteCorpusProjectionRevisionFence(db);
  await installPgliteStatuteCitationCounts(db);
  await installPgliteLegislationPayloadRevision(db);
  await installPgliteLegislationExpressionIdentity(db);
  await installPgliteProvisionExtractionState(db);
  await installPgliteCaseLawObservationFence(db);
  await installPglitePdfSigningTokenScopes(db);
  await installPgliteDesktopPresenceRls(db);
  await installPgliteChatTurnRunIdLookup(db);
  await installPgliteOrganizationMemberCapacity(db);
  await installPgliteWorkspaceContactCapacity(db);
  await installPgliteListVerificationBudgets(db);
  await installPgliteChatRunLogRls(db);
  await installPgliteSchedulerJobPauseLog(db);
  await installPgliteTreeParentGuards(db);

  await applyStellaTablePrivileges(client);
  for (const statement of ROLE_GRANT_STATEMENTS) {
    await db.execute(sql.raw(statement));
  }
  await installPgliteTimeEntryTimerSignals(db);
  await installPgliteSanctionsMonitoringTriggers(db);
  await installPglitePlaybookDocumentTypeKey(db);

  return client;
};

/**
 * Create a test PGlite: from the batching runner's snapshot when
 * PGLITE_TEST_SNAPSHOT is set, otherwise via the full in-process build so
 * solo `bun test <file>` runs keep working without the runner. A suite may
 * supply its own snapshot with additional DDL and seed data baked in.
 */
export const createTestPglite = async (snapshot?: Blob): Promise<PGlite> => {
  if (snapshot !== undefined) {
    return await PGlite.create({
      extensions: { pg_trgm },
      loadDataDir: snapshot,
    });
  }
  const snapshotPath = process.env[PGLITE_TEST_SNAPSHOT_ENV];
  if (snapshotPath === undefined || snapshotPath.length === 0) {
    return await buildFullTestPglite();
  }
  return await PGlite.create({
    extensions: { pg_trgm },
    loadDataDir: Bun.file(snapshotPath),
  });
};
