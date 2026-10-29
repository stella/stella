import { panic, Result } from "better-result";

import { sleep } from "@stll/concurrency/sleep";

import {
  INVOICE_LEGACY_PAYMENT_BACKFILL,
  INVOICE_SENT_AT_BACKFILL,
} from "@/api/lib/billing/invoice-payment-backfill";
import { CASE_LAW_COURT_DATE_PUBLISHED_INDEX } from "@/api/lib/case-law/court-date-index";
import {
  CASE_LAW_COVERAGE_COURT_INDEX,
  CASE_LAW_COVERAGE_FILING_DATE_INDEX,
  CASE_LAW_COVERAGE_INDEX,
} from "@/api/lib/case-law/coverage-index";
import {
  publishedCaseLawDecisionIndexDefinitionPredicateSql,
  publishedCaseLawDecisionIndexPredicateSql,
} from "@/api/lib/case-law/published-decisions-sql";
import {
  DOCUMENT_OUTSTANDING_DATE_INDEX,
  DOCUMENT_OUTSTANDING_INDEX,
} from "@/api/lib/legal-search/sk-document-outstanding-index";
import { MONITORING_SESSION_INDEXES } from "@/api/lib/synthetic-principal/indexes";

import {
  type RequiredMigrationIndex,
  REWRITTEN_MIGRATION_INDEXES,
} from "../lib/db/migration-history";
import { isRecord } from "../lib/type-guards";
import {
  ACCOUNT_AUDIT_CONSTRAINT,
  ACCOUNT_AUDIT_CONSTRAINT_VALIDATION,
} from "./account-audit-constraint-validation";
import {
  AGENT_SKILL_BINDING_CONSTRAINT_VALIDATIONS,
  AGENT_SKILL_BINDING_CONSTRAINTS,
} from "./agent-skill-binding-constraint-validation";
import { BackfillHeldError } from "./backfill-runtime";
import { BETTER_AUTH_OAUTH_RESOURCE_REPAIR } from "./better-auth-oauth-resource-repair";
import {
  BILLING_ACTIVITY_HOUR_CAP_CONSTRAINT_VALIDATIONS,
  BILLING_ACTIVITY_HOUR_CAP_CONSTRAINTS,
} from "./billing-activity-hour-cap-constraint-validation";
import {
  BILLING_DRAFTS_CONSTRAINT_VALIDATIONS,
  BILLING_DRAFTS_CONSTRAINTS,
} from "./billing-drafts-constraint-validation";
import {
  CASE_LAW_PARSE_PENDING_INDEX,
  CASE_LAW_PARSED_SOURCE_CONSTRAINT,
  CASE_LAW_PARSED_SOURCE_VALIDATION,
} from "./case-law-parsed-source-hash-repair";
import {
  CHAT_CONTENT_V3_CONSTRAINTS,
  CHAT_CONTENT_V3_REPAIR,
  CHAT_CONTENT_V3_SOURCES,
} from "./chat-content-v3-backfill";
import { CHAT_RUN_TEXT_BOUNDARIES } from "./chat-run-text-boundaries";
import {
  CLIENT_INVOICE_BACKFILL,
  CLIENT_INVOICE_CONSTRAINT_VALIDATIONS,
  CLIENT_INVOICE_CONSTRAINTS,
  CLIENT_INVOICE_TENANT_KEY,
} from "./client-invoice-backfill";
import { CONTACT_VAT_ID_REPAIR } from "./contact-vat-id-repair";
import {
  CORPUS_PROJECTION_CLEANUP_STALL_CONSTRAINTS,
  CORPUS_PROJECTION_CLEANUP_STALL_REPAIR,
} from "./corpus-projection-cleanup-stall-repair";
import {
  CORPUS_PROJECTION_DELETE_RECEIPT_CONSTRAINTS,
  CORPUS_PROJECTION_DELETE_RECEIPT_REPAIR,
} from "./corpus-projection-delete-receipt-repair";
import {
  DECISION_DATE_CEILING_CONSTRAINTS,
  DECISION_DATE_CEILING_REPAIR,
} from "./decision-date-ceiling-repair";
import { DOCUMENT_REVIEW_FINDING_DECISION_BACKFILL } from "./document-review-finding-decision-backfill";
import {
  EMAIL_UNDELIVERABLE_CONSTRAINT_VALIDATION,
  EMAIL_UNDELIVERABLE_CONSTRAINTS,
} from "./email-undeliverable-constraint-validation";
import { ENTITY_FEATURE_GATE_REPAIR } from "./entity-feature-gate-repair";
import {
  INVOICE_LANGUAGE_CONSTRAINT_VALIDATIONS,
  INVOICE_LANGUAGE_CONSTRAINTS,
} from "./invoice-language-constraint-validation";
import {
  LIST_VERIFICATION_CONSTRAINT_VALIDATION,
  LIST_VERIFICATION_CONSTRAINTS,
} from "./list-verification-constraint-validation";
import {
  MATTER_TIME_EXPENSE_RETENTION_CONSTRAINTS,
  MATTER_TIME_EXPENSE_RETENTION_VALIDATIONS,
} from "./matter-time-expense-retention-validation";
import { DEFAULT_MIGRATION_TIMING, timed } from "./migration-timing";
import type { MigrationTiming } from "./migration-timing";
import {
  createIndexConcurrently,
  createOnlineTableGate,
  declaresOnlineBuild,
  dropIndexConcurrently,
  reindexIndexConcurrently,
  renameIndex,
  runGatedTableWork,
} from "./online-ddl";
import type {
  GatedTableSession,
  OnlineConstraintValidation,
  OnlineIndexDeclaration,
} from "./online-ddl";
import type { OnlineIndexGateOptions } from "./online-index-gate";
import type {
  OnlineMigrationConnection,
  OnlineMigrationOutcome,
  OnlineMigrationPool,
  OnlineRepair,
  OnlineRepairCompletion,
  OnlineStepIntroduction,
} from "./online-migration-connection";
import {
  CLIENT_INVOICE_UNIQUE_INDEXES,
  EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES,
  LEGISLATION_UNIQUE_INDEXES,
  onlineUniqueIndexDefinition,
} from "./online-unique-indexes";
import {
  ORGANIZATION_ACCESS_STATE_CONSTRAINT_VALIDATIONS,
  ORGANIZATION_ACCESS_STATE_CONSTRAINTS,
} from "./organization-access-state-constraint-validation";
import {
  READER_ANNOTATION_CONSTRAINT_VALIDATIONS,
  READER_ANNOTATION_CONSTRAINTS,
} from "./reader-annotation-constraint-validation";
import {
  READER_ANSWER_CONSTRAINT_VALIDATION,
  READER_ANSWER_CONSTRAINTS,
} from "./reader-answer-constraint-validation";
import {
  SANCTIONS_MONITORING_CONSTRAINT_VALIDATIONS,
  SANCTIONS_MONITORING_CONSTRAINTS,
} from "./sanctions-monitoring-constraint-validation";
import {
  TIME_ENTRY_SUBMITTED_CONSTRAINT_VALIDATION,
  TIME_ENTRY_SUBMITTED_CONSTRAINTS,
} from "./time-entry-submitted-constraint-validation";

// Catalog work keeps a short lock budget; every statement that locks a table
// runs through the gate in `online-ddl.ts`, which lifts it and watches the
// wait instead.
const ONLINE_MIGRATION_LOCK_TIMEOUT_SQL = "SET lock_timeout = '1s'";
// Only ever tried, never awaited in the database: a statement waiting on this
// lock runs into the statement timeout long before an index build releases it.
const ONLINE_MIGRATIONS_LOCK_SQL =
  "SELECT pg_try_advisory_lock(hashtext('stella-online-migrations')) AS acquired";
const ONLINE_MIGRATIONS_UNLOCK_SQL =
  "SELECT pg_advisory_unlock(hashtext('stella-online-migrations'))";
const ONLINE_MIGRATIONS_LOCK_RETRY_MS = 1000;
// Startup reads the catalog and checkpoint rows only, so a slower statement is
// waiting on a lock or a load spike; boot fails fast instead of queueing.
const STARTUP_VALIDATION_TIMEOUT_SQL = "SET statement_timeout = '5s'";
// The session is pooled: it goes back with the timeout it came with, which
// need not be the role default a RESET would give it.
const READ_STATEMENT_TIMEOUT_SQL =
  "SELECT current_setting('statement_timeout') AS timeout";
const RESTORE_STATEMENT_TIMEOUT_SQL =
  "SELECT set_config('statement_timeout', $1, false)";

const readStatementTimeout = async (
  connection: OnlineMigrationConnection,
): Promise<string> => {
  const row = (await connection.query(READ_STATEMENT_TIMEOUT_SQL)).at(0);
  if (!isRecord(row) || typeof row["timeout"] !== "string") {
    return panic("Session statement timeout is unreadable");
  }
  return row["timeout"];
};

const tryAcquireOnlineMigrationLock = async (
  connection: OnlineMigrationConnection,
): Promise<boolean> => {
  const row = (await connection.query(ONLINE_MIGRATIONS_LOCK_SQL)).at(0);
  if (!isRecord(row) || typeof row["acquired"] !== "boolean") {
    return panic("Online migration try-lock returned no verdict");
  }
  return row["acquired"];
};

/** Waits for another migrate run to finish, one try per second. */
export const acquireOnlineMigrationLock = async (
  connection: OnlineMigrationConnection,
): Promise<void> => {
  if (await tryAcquireOnlineMigrationLock(connection)) {
    return;
  }
  await sleep(ONLINE_MIGRATIONS_LOCK_RETRY_MS);
  await acquireOnlineMigrationLock(connection);
};

export const releaseOnlineMigrationLock = async (
  connection: OnlineMigrationConnection,
): Promise<void> => {
  await connection.execute(ONLINE_MIGRATIONS_UNLOCK_SQL);
};
const READ_INDEX_STATE_SQL = `
  SELECT
    index_state.indisready AS "isReady",
    index_state.indisunique AS "isUnique",
    index_state.indisvalid AS "isValid",
    pg_get_indexdef(index_relation.oid) AS "definition",
    index_relation.relname AS "name"
  FROM pg_catalog.pg_class index_relation
  JOIN pg_catalog.pg_namespace index_namespace
    ON index_namespace.oid = index_relation.relnamespace
  JOIN pg_catalog.pg_index index_state
    ON index_state.indexrelid = index_relation.oid
  JOIN pg_catalog.pg_class table_relation
    ON table_relation.oid = index_state.indrelid
  WHERE index_namespace.nspname = $1
    AND index_relation.relname = $2
    AND table_relation.relname = $3
`;
const READ_REINDEX_ARTIFACTS_SQL = `
  SELECT
    index_state.indisready AS "isReady",
    index_state.indisunique AS "isUnique",
    index_state.indisvalid AS "isValid",
    pg_get_indexdef(index_relation.oid) AS "definition",
    index_relation.relname AS "name"
  FROM pg_catalog.pg_class index_relation
  JOIN pg_catalog.pg_namespace index_namespace
    ON index_namespace.oid = index_relation.relnamespace
  JOIN pg_catalog.pg_index index_state
    ON index_state.indexrelid = index_relation.oid
  JOIN pg_catalog.pg_class table_relation
    ON table_relation.oid = index_state.indrelid
  WHERE index_namespace.nspname = $1
    AND table_relation.relname = $2
    AND (
      starts_with(index_relation.relname, $3)
      OR starts_with(index_relation.relname, $4)
    )
`;

type OnlineIndex = OnlineIndexDeclaration & {
  introducedBy: OnlineStepIntroduction;
};

const PUBLISHED_CASE_LAW_DECISION_INDEX_PREDICATE =
  publishedCaseLawDecisionIndexPredicateSql();
const PUBLISHED_CASE_LAW_DECISION_INDEX_DEFINITION =
  publishedCaseLawDecisionIndexDefinitionPredicateSql();

export const ONLINE_MIGRATION_INDEXES: readonly OnlineIndex[] = [
  {
    name: "chat_run_log_entries_message_snapshot_idx",
    introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
    tableName: "chat_run_log_entries",
    isUnique: false,
    createSql:
      "CREATE INDEX CONCURRENTLY \"chat_run_log_entries_message_snapshot_idx\" ON public.chat_run_log_entries (organization_id, run_id, seq) WHERE chunk->>'type' = 'MESSAGES_SNAPSHOT'",
    definitionBody:
      "ON public.chat_run_log_entries USING btree (organization_id, run_id, seq) WHERE ((chunk ->> 'type'::text) = 'MESSAGES_SNAPSHOT'::text)",
  },
  {
    name: "chat_run_log_entries_text_start_idx",
    introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
    tableName: "chat_run_log_entries",
    isUnique: false,
    createSql:
      "CREATE INDEX CONCURRENTLY \"chat_run_log_entries_text_start_idx\" ON public.chat_run_log_entries (organization_id, run_id, seq) WHERE (chunk->>'type' = 'TEXT_MESSAGE_START' OR (chunk->>'type' = 'TEXT_MESSAGE_CHUNK' AND chunk ? 'role'))",
    definitionBody:
      "ON public.chat_run_log_entries USING btree (organization_id, run_id, seq) WHERE (((chunk ->> 'type'::text) = 'TEXT_MESSAGE_START'::text) OR (((chunk ->> 'type'::text) = 'TEXT_MESSAGE_CHUNK'::text) AND (chunk ? 'role'::text)))",
  },
  {
    name: "chat_run_log_entries_text_open_idx",
    introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
    tableName: "chat_run_log_entries",
    isUnique: false,
    createSql:
      "CREATE INDEX CONCURRENTLY \"chat_run_log_entries_text_open_idx\" ON public.chat_run_log_entries (organization_id, run_id, text_boundary_initialization, text_message_end_seq, seq) WHERE (chunk->>'type' = 'TEXT_MESSAGE_START' OR (chunk->>'type' = 'TEXT_MESSAGE_CHUNK' AND chunk ? 'role'))",
    definitionBody:
      "ON public.chat_run_log_entries USING btree (organization_id, run_id, text_boundary_initialization, text_message_end_seq, seq) WHERE (((chunk ->> 'type'::text) = 'TEXT_MESSAGE_START'::text) OR (((chunk ->> 'type'::text) = 'TEXT_MESSAGE_CHUNK'::text) AND (chunk ? 'role'::text)))",
  },
  {
    name: "chat_run_log_entries_text_boundary_id_idx",
    introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
    tableName: "chat_run_log_entries",
    isUnique: false,
    createSql:
      "CREATE INDEX CONCURRENTLY \"chat_run_log_entries_text_boundary_id_idx\" ON public.chat_run_log_entries (organization_id, run_id, md5(chunk->>'messageId'), seq) WHERE (chunk->>'type' = 'TEXT_MESSAGE_START' OR (chunk->>'type' = 'TEXT_MESSAGE_CHUNK' AND chunk ? 'role') OR chunk->>'type' = 'TEXT_MESSAGE_END')",
    definitionBody:
      "ON public.chat_run_log_entries USING btree (organization_id, run_id, md5((chunk ->> 'messageId'::text)), seq) WHERE (((chunk ->> 'type'::text) = 'TEXT_MESSAGE_START'::text) OR (((chunk ->> 'type'::text) = 'TEXT_MESSAGE_CHUNK'::text) AND (chunk ? 'role'::text)) OR ((chunk ->> 'type'::text) = 'TEXT_MESSAGE_END'::text))",
  },

  CASE_LAW_PARSE_PENDING_INDEX,
  {
    introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
    createSql:
      'CREATE INDEX CONCURRENTLY "agent_skills_bound_workspace_idx" ON public."agent_skills" (bound_workspace_id) WHERE bound_workspace_id IS NOT NULL',
    definitionBody:
      "ON public.agent_skills USING btree (bound_workspace_id) WHERE (bound_workspace_id IS NOT NULL)",
    isUnique: false,
    name: "agent_skills_bound_workspace_idx",
    tableName: "agent_skills",
  },
  {
    introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
    createSql:
      'CREATE INDEX CONCURRENTLY "agent_skills_bound_client_idx" ON public."agent_skills" (bound_client_id) WHERE bound_client_id IS NOT NULL',
    definitionBody:
      "ON public.agent_skills USING btree (bound_client_id) WHERE (bound_client_id IS NOT NULL)",
    isUnique: false,
    name: "agent_skills_bound_client_idx",
    tableName: "agent_skills",
  },
  {
    introducedBy: "20261019091000_legislation_publisher_identity",
    createSql:
      'CREATE INDEX CONCURRENTLY "legislation_documents_work_version_lang_idx" ON public."legislation_documents" (source_id, eli, version_valid_from, language) WHERE version_valid_from IS NOT NULL',
    definitionBody:
      "ON public.legislation_documents USING btree (source_id, eli, version_valid_from, language) WHERE (version_valid_from IS NOT NULL)",
    isUnique: false,
    name: "legislation_documents_work_version_lang_idx",
    tableName: "legislation_documents",
  },

  {
    introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
    // Serves the matter key's cascade and the claim cleanup trigger; both
    // still work, by a scan, until it exists.
    createSql:
      'CREATE INDEX CONCURRENTLY "legal_reader_annotations_verification_claim_idx" ON public."legal_reader_annotations" (workspace_id, verification_claim_id) WHERE workspace_id IS NOT NULL',
    definitionBody:
      "ON public.legal_reader_annotations USING btree (workspace_id, verification_claim_id) WHERE (workspace_id IS NOT NULL)",
    isUnique: false,
    name: "legal_reader_annotations_verification_claim_idx",
    tableName: "legal_reader_annotations",
  },
  {
    introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
    // Lists a matter document's marks and serves the document cleanup
    // trigger; both still work, by a scan, until it exists.
    createSql:
      'CREATE INDEX CONCURRENTLY "legal_reader_annotations_matter_document_idx" ON public."legal_reader_annotations" (workspace_id, entity_id, created_at, id) WHERE entity_id IS NOT NULL',
    definitionBody:
      "ON public.legal_reader_annotations USING btree (workspace_id, entity_id, created_at, id) WHERE (entity_id IS NOT NULL)",
    isUnique: false,
    name: "legal_reader_annotations_matter_document_idx",
    tableName: "legal_reader_annotations",
  },
  ...MONITORING_SESSION_INDEXES,
  ...Object.values(CHAT_CONTENT_V3_SOURCES).map(({ table: tableName }) => ({
    createSql: `CREATE INDEX CONCURRENTLY "${tableName}_content_v3_pending_idx" ON public."${tableName}" (id) WHERE (content -> 'version') IS DISTINCT FROM '3'::jsonb`,
    definitionBody: `ON public.${tableName} USING btree (id) WHERE ((content -> 'version'::text) IS DISTINCT FROM '3'::jsonb)`,
    introducedBy: CHAT_CONTENT_V3_REPAIR.introducedBy,
    isUnique: false,
    name: `${tableName}_content_v3_pending_idx`,
    tableName,
  })),
  CASE_LAW_COVERAGE_INDEX,
  CASE_LAW_COVERAGE_FILING_DATE_INDEX,
  CASE_LAW_COVERAGE_COURT_INDEX,
  // Reviewed doctrine per cited decision: few rows carry a finding.
  {
    createSql: `CREATE INDEX CONCURRENTLY "case_law_citations_doctrine_cited_idx" ON public."case_law_citations" USING btree ("cited_decision_id") WHERE "doctrinal_treatment" IN ('distinguishes', 'limits')`,
    definitionBody:
      "ON public.case_law_citations USING btree (cited_decision_id) WHERE ((doctrinal_treatment)::text = ANY ((ARRAY['distinguishes'::character varying, 'limits'::character varying])::text[]))",
    introducedBy: "20261014174500_case_law_citation_doctrine",
    isUnique: false,
    name: "case_law_citations_doctrine_cited_idx",
    tableName: "case_law_citations",
  },
  // A provision's subtree of citing rows as one byte-ordered anchor range.
  // The trailing date, decision and span let the cited-by page group a
  // subtree per decision, with its earliest mention's offset, from the index
  // alone.
  {
    introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
    createSql: `CREATE INDEX CONCURRENTLY "case_law_provision_citations_work_citing_idx" ON public."case_law_provision_citations" USING btree ("jurisdiction", "work_identifier", "anchor" COLLATE "C", "decision_date", "decision_id", "span_start")`,
    definitionBody:
      'ON public.case_law_provision_citations USING btree (jurisdiction, work_identifier, anchor COLLATE "C", decision_date, decision_id, span_start)',
    isUnique: false,
    name: "case_law_provision_citations_work_citing_idx",
    tableName: "case_law_provision_citations",
  },
  {
    introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
    createSql: `CREATE INDEX CONCURRENTLY "case_law_provision_citations_eli_citing_idx" ON public."case_law_provision_citations" USING btree ("jurisdiction", "work_eli", "anchor" COLLATE "C", "decision_date", "decision_id", "span_start") WHERE "work_eli" IS NOT NULL`,
    definitionBody:
      'ON public.case_law_provision_citations USING btree (jurisdiction, work_eli, anchor COLLATE "C", decision_date, decision_id, span_start) WHERE (work_eli IS NOT NULL)',
    isUnique: false,
    name: "case_law_provision_citations_eli_citing_idx",
    tableName: "case_law_provision_citations",
  },
  // Bounded cross-publisher ruling lookup before a decision insert.
  {
    introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
    createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_republished_ruling_idx" ON public."case_law_decisions" ("country", "court", "docket_family_key", "id") WHERE "docket_family_key" IS NOT NULL`,
    definitionBody:
      "ON public.case_law_decisions USING btree (country, court, docket_family_key, id) WHERE (docket_family_key IS NOT NULL)",
    isUnique: false,
    name: "case_law_decisions_republished_ruling_idx",
    tableName: "case_law_decisions",
  },
  // Billing guideline file search over knowledge-file paths.
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "agent_skill_resources_path_billing_trgm_idx" ON public."agent_skill_resources" USING gin ("path" gin_trgm_ops)',
    definitionBody:
      "ON public.agent_skill_resources USING gin (path gin_trgm_ops)",
    isUnique: false,
    name: "agent_skill_resources_path_billing_trgm_idx",
    tableName: "agent_skill_resources",
  },
  {
    introducedBy: "20261022233100_mcp_web_handoff_session_index",
    createSql:
      'CREATE INDEX CONCURRENTLY "session_originConsentId_idx" ON public."session" USING btree ("origin_consent_id")',
    definitionBody: "ON public.session USING btree (origin_consent_id)",
    isUnique: false,
    name: "session_originConsentId_idx",
    tableName: "session",
  },
  {
    createSql: `CREATE INDEX CONCURRENTLY "apikey_personal_owner_keyset_idx" ON public."apikey" (((metadata::jsonb ->> 'organizationId')), reference_id, created_at DESC, id DESC) WHERE metadata IS NOT NULL AND metadata::jsonb ->> 'kind' = 'personal'`,
    definitionBody:
      "ON public.apikey USING btree ((((metadata)::jsonb ->> 'organizationId'::text)), reference_id, created_at DESC, id DESC) WHERE ((metadata IS NOT NULL) AND (((metadata)::jsonb ->> 'kind'::text) = 'personal'::text))",
    introducedBy: "20261004120300_personal_api_keys",
    isUnique: false,
    name: "apikey_personal_owner_keyset_idx",
    tableName: "apikey",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "sanctions_contact_matches_org_open_cursor_idx" ON public."sanctions_contact_matches" USING btree ("organization_id", "state", "disposition", "contact_id", "source_id", "source_entry_id")',
    definitionBody:
      "ON public.sanctions_contact_matches USING btree (organization_id, state, disposition, contact_id, source_id, source_entry_id)",
    introducedBy: "20261003123000_sanctions_monitoring_review_index",
    isUnique: false,
    name: "sanctions_contact_matches_org_open_cursor_idx",
    tableName: "sanctions_contact_matches",
  },
  CASE_LAW_COURT_DATE_PUBLISHED_INDEX,
  {
    createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_country_date_published_idx" ON public."case_law_decisions" USING btree ("country", coalesce("decision_date", '-infinity'::date), "id") WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_PREDICATE}`,
    definitionBody: `ON public.case_law_decisions USING btree (country, COALESCE(decision_date, '-infinity'::date), id) WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_DEFINITION}`,
    introducedBy: "20261010212100_case_law_publication_filter",
    isUnique: false,
    name: "case_law_decisions_country_date_published_idx",
    tableName: "case_law_decisions",
  },
  {
    introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
    createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_country_language_date_published_idx" ON public."case_law_decisions" USING btree ("country", "language", coalesce("decision_date", '-infinity'::date), "id") WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_PREDICATE}`,
    definitionBody: `ON public.case_law_decisions USING btree (country, language, COALESCE(decision_date, '-infinity'::date), id) WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_DEFINITION}`,
    isUnique: false,
    name: "case_law_decisions_country_language_date_published_idx",
    tableName: "case_law_decisions",
  },
  {
    createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_citation_candidate_published_idx" ON public."case_law_decisions" USING btree ("citation_key", "country", "decision_date", "id") WHERE "citation_key" IS NOT NULL AND ${PUBLISHED_CASE_LAW_DECISION_INDEX_PREDICATE}`,
    definitionBody: `ON public.case_law_decisions USING btree (citation_key, country, decision_date, id) WHERE ((citation_key IS NOT NULL) AND ${PUBLISHED_CASE_LAW_DECISION_INDEX_DEFINITION})`,
    introducedBy: "20261010212100_case_law_publication_filter",
    isUnique: false,
    name: "case_law_decisions_citation_candidate_published_idx",
    tableName: "case_law_decisions",
  },
  {
    createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_source_arrivals_published_idx" ON public."case_law_decisions" USING btree ("source_id", "created_at") WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_PREDICATE}`,
    definitionBody: `ON public.case_law_decisions USING btree (source_id, created_at) WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_DEFINITION}`,
    introducedBy: "20261010212100_case_law_publication_filter",
    isUnique: false,
    name: "case_law_decisions_source_arrivals_published_idx",
    tableName: "case_law_decisions",
  },
  {
    createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_sitemap_shard_published_idx" ON public."case_law_decisions" USING btree ("country", "decision_date", "source_id", "updated_at", "id") WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_PREDICATE}`,
    definitionBody: `ON public.case_law_decisions USING btree (country, decision_date, source_id, updated_at, id) WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_DEFINITION}`,
    introducedBy: "20261010212100_case_law_publication_filter",
    isUnique: false,
    name: "case_law_decisions_sitemap_shard_published_idx",
    tableName: "case_law_decisions",
  },
  {
    createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_search_candidate_published_idx" ON public."case_law_decisions" USING btree ("id", "country", "source_id", "court", "decision_date", "decision_type", "language", "citation_authority", "language_group_key") WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_PREDICATE}`,
    definitionBody: `ON public.case_law_decisions USING btree (id, country, source_id, court, decision_date, decision_type, language, citation_authority, language_group_key) WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_DEFINITION}`,
    introducedBy: "20261010212100_case_law_publication_filter",
    isUnique: false,
    name: "case_law_decisions_search_candidate_published_idx",
    tableName: "case_law_decisions",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "sanctions_screening_events_org_cursor_idx" ON public."sanctions_screening_events" USING btree ("organization_id", "created_at", "id")',
    definitionBody:
      "ON public.sanctions_screening_events USING btree (organization_id, created_at, id)",
    introducedBy: "20261003123000_sanctions_monitoring_review_index",
    isUnique: false,
    name: "sanctions_screening_events_org_cursor_idx",
    tableName: "sanctions_screening_events",
  },
  onlineUniqueIndexDefinition(
    EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.CONTACTS_ORG_ID_UNIQUE,
  ),
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "rate_entries_table_role_from_idx" ON public."rate_entries" USING btree ("rate_table_id", "role", "effective_from")',
    definitionBody:
      "ON public.rate_entries USING btree (rate_table_id, role, effective_from)",
    introducedBy: "20261003123000_billing_role_index",
    isUnique: false,
    name: "rate_entries_table_role_from_idx",
    tableName: "rate_entries",
  },
  onlineUniqueIndexDefinition(
    EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.SESSION_PRIOR_TOKEN_HASH_IDX,
  ),
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "time_entries_org_status_date_id_idx" ON public."time_entries" USING btree ("organization_id", "status", "date_worked", "id")',
    definitionBody:
      "ON public.time_entries USING btree (organization_id, status, date_worked, id)",
    introducedBy: "20261003122800_time_entry_activity_groups",
    isUnique: false,
    name: "time_entries_org_status_date_id_idx",
    tableName: "time_entries",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "time_entries_approval_queue_idx" ON public."time_entries" USING btree ("organization_id", "approver_user_id", "status", "date_worked", "id") WHERE "status" = \'draft\'',
    definitionBody:
      "ON public.time_entries USING btree (organization_id, approver_user_id, status, date_worked, id) WHERE (status = 'draft'::text)",
    introducedBy: "20261003122700_time_entry_approval_queue",
    isUnique: false,
    name: "time_entries_approval_queue_idx",
    tableName: "time_entries",
  },
  {
    introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
    createSql:
      'CREATE INDEX CONCURRENTLY "time_entries_submitted_queue_idx" ON public."time_entries" USING btree ("organization_id", "approver_user_id", "date_worked", "id") WHERE "status" = \'submitted\'',
    definitionBody:
      "ON public.time_entries USING btree (organization_id, approver_user_id, date_worked, id) WHERE (status = 'submitted'::text)",
    isUnique: false,
    name: "time_entries_submitted_queue_idx",
    tableName: "time_entries",
  },
  {
    introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
    createSql:
      'CREATE INDEX CONCURRENTLY "invoice_lines_workspace_organization_idx" ON public."invoice_lines" USING btree (workspace_id, organization_id)',
    definitionBody:
      "ON public.invoice_lines USING btree (workspace_id, organization_id)",
    isUnique: false,
    name: "invoice_lines_workspace_organization_idx",
    tableName: "invoice_lines",
  },
  {
    introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
    createSql:
      'CREATE INDEX CONCURRENTLY "invoices_org_client_created_idx" ON public."invoices" USING btree (organization_id, client_id, created_at, id)',
    definitionBody:
      "ON public.invoices USING btree (organization_id, client_id, created_at, id)",
    isUnique: false,
    name: "invoices_org_client_created_idx",
    tableName: "invoices",
  },
  ...CLIENT_INVOICE_UNIQUE_INDEXES,
  ...LEGISLATION_UNIQUE_INDEXES,
  {
    introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
    createSql:
      'CREATE INDEX CONCURRENTLY "invoices_client_backfill_idx" ON public."invoices" USING btree (id) WHERE client_id IS NULL AND workspace_id IS NOT NULL',
    definitionBody:
      "ON public.invoices USING btree (id) WHERE ((client_id IS NULL) AND (workspace_id IS NOT NULL))",
    isUnique: false,
    name: "invoices_client_backfill_idx",
    tableName: "invoices",
  },
  onlineUniqueIndexDefinition(
    EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.INVOICES_ID_WORKSPACE_UNIQUE,
  ),
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "invoices_ws_original_idx" ON public."invoices" USING btree ("workspace_id", "original_invoice_id")',
    definitionBody:
      "ON public.invoices USING btree (workspace_id, original_invoice_id)",
    introducedBy: "20261003122400_invoice_document_types",
    isUnique: false,
    name: "invoices_ws_original_idx",
    tableName: "invoices",
  },
  onlineUniqueIndexDefinition(
    EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.LEGAL_LISTS_SAMPLE_WORKSPACE_UIDX,
  ),
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "case_law_decisions_provision_scope_cursor_idx" ON public."case_law_decisions" USING btree ("country", "language", "id")',
    definitionBody:
      "ON public.case_law_decisions USING btree (country, language, id)",
    introducedBy: "20260926170000_case_law_provision_backfill",
    isUnique: false,
    name: "case_law_decisions_provision_scope_cursor_idx",
    tableName: "case_law_decisions",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "case_law_provision_extractions_jurisdiction_due_idx" ON public."case_law_provision_extractions" USING btree ("jurisdiction", "lane", "due_at", "decision_id") WHERE "due_at" IS NOT NULL AND "work_status" <> \'blocked\'',
    definitionBody:
      "ON public.case_law_provision_extractions USING btree (jurisdiction, lane, due_at, decision_id) WHERE ((due_at IS NOT NULL) AND (work_status <> 'blocked'::text))",
    introducedBy:
      "20261004120300_provision_extraction_jurisdiction_claim_index",
    isUnique: false,
    name: "case_law_provision_extractions_jurisdiction_due_idx",
    tableName: "case_law_provision_extractions",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "case_law_provision_extractions_pending_idx" ON public."case_law_provision_extractions" USING btree ("jurisdiction", "pending_since", "decision_id") WHERE "pending_since" IS NOT NULL',
    definitionBody:
      "ON public.case_law_provision_extractions USING btree (jurisdiction, pending_since, decision_id) WHERE (pending_since IS NOT NULL)",
    introducedBy: "20261010110000_case_law_provision_pending_since",
    isUnique: false,
    name: "case_law_provision_extractions_pending_idx",
    tableName: "case_law_provision_extractions",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "case_law_provision_extractions_clock_seed_idx" ON public."case_law_provision_extractions" USING btree ("decision_id") WHERE "due_at" IS NOT NULL AND "pending_since" IS NULL',
    definitionBody:
      "ON public.case_law_provision_extractions USING btree (decision_id) WHERE ((due_at IS NOT NULL) AND (pending_since IS NULL))",
    introducedBy: "20261010110000_case_law_provision_pending_since",
    isUnique: false,
    name: "case_law_provision_extractions_clock_seed_idx",
    tableName: "case_law_provision_extractions",
  },
  DOCUMENT_OUTSTANDING_INDEX,
  DOCUMENT_OUTSTANDING_DATE_INDEX,
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "case_law_decisions_docket_family_key_idx" ON public."case_law_decisions" USING btree ("docket_family_key") WHERE "docket_family_key" IS NOT NULL',
    definitionBody:
      "ON public.case_law_decisions USING btree (docket_family_key) WHERE (docket_family_key IS NOT NULL)",
    introducedBy: "20261003123300_case_law_decision_docket_family_key",
    isUnique: false,
    name: "case_law_decisions_docket_family_key_idx",
    tableName: "case_law_decisions",
  },
  onlineUniqueIndexDefinition(
    EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.ACCOUNT_PROVIDER_ACCOUNT_ID_UIDX,
  ),
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "chat_thread_compactions_memory_unmined_org_idx" ON public."chat_thread_compactions" USING btree ("memory_extraction_organization_id", "memory_extraction_consent_at", "memory_extraction_attempted_at" ASC NULLS FIRST, "created_at", "id") WHERE "memory_extraction_organization_id" IS NOT NULL AND "memory_extraction_consent_at" IS NOT NULL AND "memory_extracted_at" IS NULL AND "status" = \'active\'',
    definitionBody:
      "ON public.chat_thread_compactions USING btree (memory_extraction_organization_id, memory_extraction_consent_at, memory_extraction_attempted_at NULLS FIRST, created_at, id) WHERE ((memory_extraction_organization_id IS NOT NULL) AND (memory_extraction_consent_at IS NOT NULL) AND (memory_extracted_at IS NULL) AND ((status)::text = 'active'::text))",
    introducedBy: "20260808006000_ai_memory_extractor_index",
    isUnique: false,
    name: "chat_thread_compactions_memory_unmined_org_idx",
    tableName: "chat_thread_compactions",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "organization_settings_memory_extraction_queue_idx" ON public."organization_settings" USING btree ("memory_extraction_scheduled_at", "organization_id") WHERE "memory_extraction_enabled" = true AND "memory_extraction_scheduled_at" IS NOT NULL',
    definitionBody:
      "ON public.organization_settings USING btree (memory_extraction_scheduled_at, organization_id) WHERE ((memory_extraction_enabled = true) AND (memory_extraction_scheduled_at IS NOT NULL))",
    introducedBy: "20260808006000_ai_memory_extractor_index",
    isUnique: false,
    name: "organization_settings_memory_extraction_queue_idx",
    tableName: "organization_settings",
  },
  onlineUniqueIndexDefinition(
    EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.WORKSPACES_ID_ORG_UNQ,
  ),
  onlineUniqueIndexDefinition(
    EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.ENTITY_VERSIONS_ID_ENTITY_WS_UIDX,
  ),
  onlineUniqueIndexDefinition(
    EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.ENTITY_VERSIONS_ENTITY_NUMBER_UIDX,
  ),
  onlineUniqueIndexDefinition(
    EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.CHAT_MESSAGES_ID_THREAD_UIDX,
  ),
  onlineUniqueIndexDefinition(
    EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.TIME_ENTRIES_ONE_ACTIVE_TIMER_PER_USER_IDX,
  ),
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "time_timers_running_org_id_idx" ON public."time_timers" USING btree ("organization_id", "id") WHERE "state" = \'running\'',
    definitionBody:
      "ON public.time_timers USING btree (organization_id, id) WHERE (state = 'running'::text)",
    introducedBy: "20261003122600_timer_admin_stop",
    isUnique: false,
    name: "time_timers_running_org_id_idx",
    tableName: "time_timers",
  },
  onlineUniqueIndexDefinition(
    EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.TIME_TIMERS_LEGACY_ENTRY_UIDX,
  ),
  onlineUniqueIndexDefinition(
    EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.PLAYBOOK_DEFINITIONS_ORG_STARTER_ID_UIDX,
  ),
  onlineUniqueIndexDefinition(
    EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.TEMPLATES_ORG_PACK_TEMPLATE_UIDX,
  ),
  onlineUniqueIndexDefinition(
    EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.WORKSPACE_VIEWS_CORRESPONDENCE_UIDX,
  ),
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "report_exports_workspace_requester_created_idx" ON public."report_exports" USING btree ("workspace_id", "requested_by", "created_at", "id")',
    definitionBody:
      "ON public.report_exports USING btree (workspace_id, requested_by, created_at, id)",
    introducedBy: "20260717160000_report_export_history_index",
    isUnique: false,
    name: "report_exports_workspace_requester_created_idx",
    tableName: "report_exports",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "folio_collab_rooms_workspace_source_version_idx" ON public."folio_collab_rooms" USING btree ("workspace_id", "source_version_id")',
    definitionBody:
      "ON public.folio_collab_rooms USING btree (workspace_id, source_version_id)",
    introducedBy: "20260913100100_validate_folio_collab_source_version",
    isUnique: false,
    name: "folio_collab_rooms_workspace_source_version_idx",
    tableName: "folio_collab_rooms",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "legislation_documents_country_slug_idx" ON public."legislation_documents" USING btree ("country", "slug") WHERE "slug" IS NOT NULL',
    definitionBody:
      "ON public.legislation_documents USING btree (country, slug) WHERE (slug IS NOT NULL)",
    introducedBy: "20260913220000_legislation_document_slugs",
    isUnique: false,
    name: "legislation_documents_country_slug_idx",
    tableName: "legislation_documents",
  },
  onlineUniqueIndexDefinition(
    EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.CHAT_TURNS_ORG_RUN_ID_UIDX,
  ),
  onlineUniqueIndexDefinition(
    EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.LEGAL_READER_ANSWER_MESSAGES_ANSWER_SEQUENCE_IDX,
  ),
  onlineUniqueIndexDefinition(
    EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.CASE_LAW_INGESTION_FAILURES_SOURCE_RECORD_UIDX,
  ),
  onlineUniqueIndexDefinition(
    EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.CORRESPONDENCE_WS_SOURCE_ENTITY_UIDX,
  ),
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "correspondence_attachments_ws_entity_idx" ON public."correspondence_attachments" USING btree ("workspace_id", "entity_id")',
    definitionBody:
      "ON public.correspondence_attachments USING btree (workspace_id, entity_id)",
    introducedBy: "20261004120100_uploaded_mail_correspondence",
    isUnique: false,
    name: "correspondence_attachments_ws_entity_idx",
    tableName: "correspondence_attachments",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "sanctions_contact_marks_retry_idx" ON public."sanctions_contact_marks" USING btree ("next_attempt_at", "scheduled_at", "organization_id", "contact_id")',
    definitionBody:
      "ON public.sanctions_contact_marks USING btree (next_attempt_at, scheduled_at, organization_id, contact_id)",
    introducedBy: "20261005120200_list_verification_force_rls",
    isUnique: false,
    name: "sanctions_contact_marks_retry_idx",
    tableName: "sanctions_contact_marks",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "sanctions_contact_marks_organization_retry_idx" ON public."sanctions_contact_marks" USING btree ("organization_id", "next_attempt_at", "scheduled_at", "contact_id")',
    definitionBody:
      "ON public.sanctions_contact_marks USING btree (organization_id, next_attempt_at, scheduled_at, contact_id)",
    introducedBy: "20261005120200_list_verification_force_rls",
    isUnique: false,
    name: "sanctions_contact_marks_organization_retry_idx",
    tableName: "sanctions_contact_marks",
  },
  {
    introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
    createSql:
      'CREATE INDEX CONCURRENTLY "search_history_entries_owner_country_recent_idx" ON public."search_history_entries" USING btree ("organization_id", "user_id", "country", "last_used_at", "id")',
    definitionBody:
      "ON public.search_history_entries USING btree (organization_id, user_id, country, last_used_at, id)",
    isUnique: false,
    name: "search_history_entries_owner_country_recent_idx",
    tableName: "search_history_entries",
  },
  ...REWRITTEN_MIGRATION_INDEXES,
];

type OnlineIndexCutover = {
  introducedBy: string;
  final: RequiredMigrationIndex & { introducedBy: OnlineStepIntroduction };
  legacy: RequiredMigrationIndex;
  staged: OnlineIndex;
};

export const ONLINE_MIGRATION_INDEX_CUTOVERS: readonly OnlineIndexCutover[] = [
  {
    introducedBy: "20260801150000_document_processing_queue_nulls_first",
    final: {
      definitionBody:
        "ON public.case_law_decisions USING btree (updated_at DESC, id DESC)",
      introducedBy: "20260801150000_document_processing_queue_nulls_first",
      isUnique: false,
      name: "case_law_decisions_updated_id_idx",
      tableName: "case_law_decisions",
    },
    legacy: {
      definitionBody:
        "ON public.case_law_decisions USING btree (updated_at, id)",
      isUnique: false,
      name: "case_law_decisions_updated_id_idx",
      tableName: "case_law_decisions",
    },
    staged: {
      createSql:
        'CREATE INDEX CONCURRENTLY "case_law_decisions_updated_id_idx_replacement" ON public."case_law_decisions" USING btree ("updated_at" DESC, "id" DESC)',
      definitionBody:
        "ON public.case_law_decisions USING btree (updated_at DESC, id DESC)",
      introducedBy: "20260801150000_document_processing_queue_nulls_first",
      isUnique: false,
      name: "case_law_decisions_updated_id_idx_replacement",
      tableName: "case_law_decisions",
    },
  },
];

type OnlineIndexReplacement = {
  introducedBy: OnlineStepIntroduction;
  legacyName: string;
  replacementNames: readonly string[];
};

export const ONLINE_INDEX_REPLACEMENTS: readonly OnlineIndexReplacement[] = [
  {
    introducedBy: "20261010212100_case_law_publication_filter",
    legacyName: "case_law_decisions_country_date_idx",
    replacementNames: ["case_law_decisions_country_date_published_idx"],
  },
  {
    introducedBy: "20261010212100_case_law_publication_filter",
    legacyName: "case_law_decisions_source_arrivals_idx",
    replacementNames: ["case_law_decisions_source_arrivals_published_idx"],
  },
  {
    introducedBy: "20261010212100_case_law_publication_filter",
    legacyName: "case_law_decisions_sitemap_shard_idx",
    replacementNames: ["case_law_decisions_sitemap_shard_published_idx"],
  },
  {
    introducedBy: "20261010212100_case_law_publication_filter",
    legacyName: "case_law_decisions_search_candidate_idx",
    replacementNames: ["case_law_decisions_search_candidate_published_idx"],
  },
  {
    introducedBy: LEGISLATION_UNIQUE_INDEXES[0].introducedBy,
    legacyName: "legislation_documents_eli_version_lang_idx",
    replacementNames: [
      "legislation_documents_work_version_lang_idx",
      "legislation_documents_publisher_identity_idx",
      "legislation_documents_legacy_version_lang_idx",
    ],
  },
  {
    introducedBy: LEGISLATION_UNIQUE_INDEXES[0].introducedBy,
    legacyName: "legislation_documents_eli_current_lang_idx",
    replacementNames: [
      "legislation_documents_publisher_identity_idx",
      "legislation_documents_legacy_current_lang_idx",
    ],
  },
  {
    introducedBy: "20261010212300_reader_answer_message_sequence",
    legacyName: "legal_reader_answer_messages_answer_idx",
    replacementNames: ["legal_reader_answer_messages_answer_sequence_idx"],
  },
  {
    introducedBy: "20261003124500_public_law_reader_passage_counts",
    legacyName: "case_law_decisions_document_pending_date_idx",
    replacementNames: [DOCUMENT_OUTSTANDING_DATE_INDEX.name],
  },
  {
    introducedBy: "20260731130000_decision_source_document_id",
    legacyName: "case_law_decisions_source_case_lang_idx",
    replacementNames: [
      "case_law_decisions_source_document_idx",
      "case_law_decisions_source_case_lang_null_idx",
    ],
  },
  // A provision's citing rows are its whole subtree, which the exact-anchor
  // walks cannot seek under the database collation.
  {
    introducedBy: "20260819110000_case_law_provision_citations",
    legacyName: "case_law_provision_citations_work_anchor_idx",
    replacementNames: ["case_law_provision_citations_work_citing_idx"],
  },
  {
    introducedBy: "20260819130000_case_law_provision_citations_eli_idx",
    legacyName: "case_law_provision_citations_eli_anchor_idx",
    replacementNames: ["case_law_provision_citations_eli_citing_idx"],
  },
  // The subtree ranges, now carrying the cited-by page's grouping keys.
  {
    introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
    legacyName: "case_law_provision_citations_work_subtree_idx",
    replacementNames: ["case_law_provision_citations_work_citing_idx"],
  },
  {
    introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
    legacyName: "case_law_provision_citations_eli_subtree_idx",
    replacementNames: ["case_law_provision_citations_eli_citing_idx"],
  },
  // Better Auth 1.7.3 stopped writing `issuer`, so the account identity key is
  // (provider_id, account_id): the pair the library links accounts by. The
  // replacement is proven ready before this retires the legacy index, so no
  // window exists where neither enforces uniqueness.
  {
    introducedBy: "20260916140000_account_issuer_nullable",
    legacyName: "account_issuer_account_id_uidx",
    replacementNames: ["account_provider_account_id_uidx"],
  },
];

/**
 * Index names a concurrent `IF NOT EXISTS` build may rely on, because this
 * phase reconciles them on every boot.
 *
 * Retired legacy names count: a replacement is proven ready before the legacy
 * index is dropped, and the drop reconciles an `INVALID` leftover from an
 * interrupted historical build as surely as a rebuild would. A name with
 * neither a registry entry, a cutover, nor a retirement still has no
 * postcondition and is still rejected.
 */
export const ONLINE_VALIDATED_INDEX_NAMES: ReadonlySet<string> = new Set([
  ...ONLINE_MIGRATION_INDEXES.map(({ name }) => name),
  ...ONLINE_MIGRATION_INDEX_CUTOVERS.flatMap(({ final, staged }) => [
    final.name,
    staged.name,
  ]),
  ...ONLINE_INDEX_REPLACEMENTS.map(({ legacyName }) => legacyName),
]);

/**
 * Data repairs a schema migration left to this phase, run after the index
 * steps so an index a repair walks is one that already exists. Each is
 * self-checkpointing (see `OnlineRepair`); the phase only sequences them,
 * skips the ones already complete, and validates their completion.
 */
export const ONLINE_MIGRATION_REPAIRS: readonly OnlineRepair[] = [
  CHAT_RUN_TEXT_BOUNDARIES,
  ACCOUNT_AUDIT_CONSTRAINT_VALIDATION,
  CLIENT_INVOICE_TENANT_KEY,
  CLIENT_INVOICE_BACKFILL,
  ...CLIENT_INVOICE_CONSTRAINT_VALIDATIONS,
  ...MATTER_TIME_EXPENSE_RETENTION_VALIDATIONS,
  CASE_LAW_PARSED_SOURCE_VALIDATION,
  ...AGENT_SKILL_BINDING_CONSTRAINT_VALIDATIONS,
  CHAT_CONTENT_V3_REPAIR,
  DECISION_DATE_CEILING_REPAIR,
  CORPUS_PROJECTION_DELETE_RECEIPT_REPAIR,
  ...SANCTIONS_MONITORING_CONSTRAINT_VALIDATIONS,
  LIST_VERIFICATION_CONSTRAINT_VALIDATION,
  ...BILLING_DRAFTS_CONSTRAINT_VALIDATIONS,
  ...ORGANIZATION_ACCESS_STATE_CONSTRAINT_VALIDATIONS,
  ...READER_ANNOTATION_CONSTRAINT_VALIDATIONS,
  READER_ANSWER_CONSTRAINT_VALIDATION,
  ...INVOICE_LANGUAGE_CONSTRAINT_VALIDATIONS,
  ...BILLING_ACTIVITY_HOUR_CAP_CONSTRAINT_VALIDATIONS,
  EMAIL_UNDELIVERABLE_CONSTRAINT_VALIDATION,
  TIME_ENTRY_SUBMITTED_CONSTRAINT_VALIDATION,
  CONTACT_VAT_ID_REPAIR,
  INVOICE_SENT_AT_BACKFILL,
  INVOICE_LEGACY_PAYMENT_BACKFILL,
  ENTITY_FEATURE_GATE_REPAIR,
  CORPUS_PROJECTION_CLEANUP_STALL_REPAIR,
  BETTER_AUTH_OAUTH_RESOURCE_REPAIR,
  DOCUMENT_REVIEW_FINDING_DECISION_BACKFILL,
];

/**
 * Every constraint a registered repair validates through the table gate. The
 * entity feature gate's checks are validated on each relation of a graph the
 * database holds, so `ENTITY_FEATURE_GATE_CONSTRAINT_NAMES` names those.
 */
export const ONLINE_CONSTRAINT_VALIDATIONS: readonly OnlineConstraintValidation[] =
  [
    ACCOUNT_AUDIT_CONSTRAINT,
    ...CLIENT_INVOICE_CONSTRAINTS,
    ...MATTER_TIME_EXPENSE_RETENTION_CONSTRAINTS,
    CASE_LAW_PARSED_SOURCE_CONSTRAINT,
    ...AGENT_SKILL_BINDING_CONSTRAINTS,
    ...CHAT_CONTENT_V3_CONSTRAINTS,
    ...DECISION_DATE_CEILING_CONSTRAINTS,
    ...CORPUS_PROJECTION_DELETE_RECEIPT_CONSTRAINTS,
    ...SANCTIONS_MONITORING_CONSTRAINTS,
    ...LIST_VERIFICATION_CONSTRAINTS,
    ...BILLING_DRAFTS_CONSTRAINTS,
    ...ORGANIZATION_ACCESS_STATE_CONSTRAINTS,
    ...READER_ANNOTATION_CONSTRAINTS,
    ...READER_ANSWER_CONSTRAINTS,
    ...INVOICE_LANGUAGE_CONSTRAINTS,
    ...BILLING_ACTIVITY_HOUR_CAP_CONSTRAINTS,
    ...EMAIL_UNDELIVERABLE_CONSTRAINTS,
    ...TIME_ENTRY_SUBMITTED_CONSTRAINTS,
    ...CORPUS_PROJECTION_CLEANUP_STALL_CONSTRAINTS,
  ];

type PresentIndexState = {
  definition: string;
  isReady: boolean;
  isUnique: boolean;
  isValid: boolean;
  name: string;
  type: "present";
};

type OnlineIndexState = { type: "missing" } | PresentIndexState;

/** Only repair builds indexes, so only repair carries the index gate. */
type OnlineMigrationMode =
  | {
      operation: "repair";
      indexGate: OnlineIndexGateOptions;
      reserveObserver: () => Promise<OnlineMigrationConnection>;
      timing: MigrationTiming;
    }
  | { operation: "validate"; report: OnlineMigrationStartupReport };

type OnlineMigrationOptions = {
  repairs?: readonly OnlineRepair[];
  log?: (record: {
    event: "online_repair_pending";
    repair: string;
    completion: Extract<OnlineRepairCompletion, { type: "pending" }>;
  }) => void;
};

const COMPLETE = { type: "complete" } as const satisfies OnlineMigrationOutcome;

export type OnlineRepairOptions = OnlineMigrationOptions & {
  indexGate: OnlineIndexGateOptions;
  /** Opens a separate session in the database `pool` reserves from. */
  reserveObserver: () => Promise<OnlineMigrationConnection>;
  /** Where each step's duration goes; JSON lines on stdout otherwise. */
  timing?: MigrationTiming;
};

export const runOnlineMigrations = async (
  pool: OnlineMigrationPool,
  {
    indexGate,
    reserveObserver,
    timing = DEFAULT_MIGRATION_TIMING,
    ...options
  }: OnlineRepairOptions,
): Promise<OnlineMigrationOutcome> =>
  await processOnlineMigrations(
    pool,
    { operation: "repair", indexGate, reserveObserver, timing },
    options,
  );

type PendingOnlineMigrationStep = {
  kind: "index" | "cutover" | "replacement_drop" | "repair";
  name: string;
  introducedBy: OnlineStepIntroduction;
};

export type OnlineMigrationStartupReport = {
  newestAppliedMigration: string;
  pending: PendingOnlineMigrationStep[];
};

/**
 * Startup validation. It never waits on the migrator: a migrate run holds the
 * online lock for a whole index build, longer than any statement timeout, so
 * a waiting boot would fail on the timeout instead. While the migrator holds
 * the lock it owns these objects and may be mid-cutover, so startup leaves
 * them to it rather than read a state between two of its statements.
 */
export const reportOnlineMigrations = async (
  pool: OnlineMigrationPool,
  options: OnlineMigrationOptions = {},
): Promise<
  | { type: "validated"; report: OnlineMigrationStartupReport }
  | { type: "migrator_active" }
> => {
  const connection = await pool.reserve();
  try {
    const sessionTimeout = await readStatementTimeout(connection);
    await connection.execute(STARTUP_VALIDATION_TIMEOUT_SQL);
    try {
      if (!(await tryAcquireOnlineMigrationLock(connection))) {
        return { type: "migrator_active" };
      }
      try {
        const row = (
          await connection.query(
            "SELECT name FROM drizzle.__drizzle_migrations WHERE name IS NOT NULL ORDER BY name DESC LIMIT 1",
          )
        ).at(0);
        if (!isRecord(row) || typeof row["name"] !== "string") {
          panic("Online migration startup requires a named applied migration");
        }
        const report: OnlineMigrationStartupReport = {
          newestAppliedMigration: row["name"],
          pending: [],
        };
        const outcome = await walkOnlineMigrations({
          connection,
          mode: { operation: "validate", report },
          options,
        });
        if (outcome.type !== "complete") {
          panic("Online migration validation cannot defer");
        }
        return { type: "validated", report };
      } finally {
        await releaseOnlineMigrationLock(connection);
      }
    } finally {
      await connection.query(RESTORE_STATEMENT_TIMEOUT_SQL, [sessionTimeout]);
    }
  } finally {
    await connection.release();
  }
};

type ReportPendingStepOptions = {
  report: OnlineMigrationStartupReport;
  step: PendingOnlineMigrationStep;
  reason: string;
};

const reportPendingStep = ({
  report,
  step,
  reason,
}: ReportPendingStepOptions): void => {
  if (typeof step.introducedBy !== "string") {
    panic(
      `Online ${step.kind} ${step.name} owned by ${step.introducedBy.owner} is not complete: ${reason}`,
    );
  }
  if (step.introducedBy !== report.newestAppliedMigration) {
    panic(
      `Online ${step.kind} ${step.name} introduced by ${step.introducedBy} is not complete: ${reason}`,
    );
  }
  if (
    !report.pending.some(
      ({ kind, name }) => kind === step.kind && name === step.name,
    )
  ) {
    report.pending.push(step);
  }
};

const processOnlineMigrations = async (
  pool: OnlineMigrationPool,
  mode: Extract<OnlineMigrationMode, { operation: "repair" }>,
  options: OnlineMigrationOptions,
): Promise<OnlineMigrationOutcome> => {
  const connection = await pool.reserve();
  let sessionStatus: "active" | "terminated" = "active";
  const sessionIsActive = () => sessionStatus === "active";
  const terminate = connection.terminate;
  if (terminate) {
    connection.terminate = async () => {
      sessionStatus = "terminated";
      await terminate();
    };
  }
  let lockAcquired = false;

  try {
    await acquireOnlineMigrationLock(connection);
    lockAcquired = true;
    await connection.execute(ONLINE_MIGRATION_LOCK_TIMEOUT_SQL);
    await connection.execute("SET statement_timeout = '0'");
    return await walkOnlineMigrations({ connection, mode, options });
  } finally {
    try {
      if (lockAcquired && sessionIsActive()) {
        await releaseOnlineMigrationLock(connection);
      }
    } finally {
      await connection.release();
    }
  }
};

type WalkOnlineMigrationsOptions = {
  connection: OnlineMigrationConnection;
  mode: OnlineMigrationMode;
  options: OnlineMigrationOptions;
};

/** Every online step in order, on a session that holds the online lock. */
const walkOnlineMigrations = async ({
  connection,
  mode,
  options,
}: WalkOnlineMigrationsOptions): Promise<OnlineMigrationOutcome> => {
  const indexes = await processOnlineIndexAt({ connection, mode });
  if (indexes.type === "deferred") {
    return indexes;
  }
  const cutovers = await processOnlineIndexCutoverAt({ connection, mode });
  if (cutovers.type === "deferred") {
    return cutovers;
  }
  if (mode.operation === "repair") {
    const retirements = await retireReplacedIndexAt(connection, mode);
    if (retirements.type === "deferred") {
      return retirements;
    }
  } else {
    await reportOnlineReplacements({ connection, report: mode.report });
  }
  return await processOnlineRepairAt({
    connection,
    mode,
    repairs: options.repairs ?? ONLINE_MIGRATION_REPAIRS,
    log:
      options.log ??
      ((record) => process.stderr.write(`${JSON.stringify(record)}\n`)),
  });
};

type OnlineIndexWalkOptions = {
  connection: OnlineMigrationConnection;
  mode: OnlineMigrationMode;
  offset?: number;
};

const processOnlineIndexAt = async ({
  connection,
  mode,
  offset = 0,
}: OnlineIndexWalkOptions): Promise<OnlineMigrationOutcome> => {
  const index = ONLINE_MIGRATION_INDEXES.at(offset);
  if (!index) {
    return COMPLETE;
  }

  if (mode.operation === "repair") {
    const step = {
      event: "migrate.online_step_duration",
      kind: "index",
      name: index.name,
    } as const;
    const outcome = await timed({
      timing: mode.timing,
      work: async () =>
        await ensureOnlineIndexValid({
          connection,
          index,
          gate: mode.indexGate,
          reserveObserver: mode.reserveObserver,
        }),
      describe: ({ type }) => ({ ...step, outcome: type }),
      failure: { ...step, outcome: "failed" },
    });
    if (outcome.type === "deferred") {
      return outcome;
    }
  } else {
    await reportIndexReadiness({
      connection,
      index,
      report: mode.report,
      kind: "index",
    });
  }
  return await processOnlineIndexAt({
    connection,
    mode,
    offset: offset + 1,
  });
};

const processOnlineIndexCutoverAt = async ({
  connection,
  mode,
  offset = 0,
}: OnlineIndexWalkOptions): Promise<OnlineMigrationOutcome> => {
  const cutover = ONLINE_MIGRATION_INDEX_CUTOVERS.at(offset);
  if (!cutover) {
    return COMPLETE;
  }

  if (mode.operation === "repair") {
    const step = {
      event: "migrate.online_step_duration",
      kind: "cutover",
      name: cutover.final.name,
    } as const;
    const outcome = await timed({
      timing: mode.timing,
      work: async () =>
        await completeIndexCutover({
          connection,
          cutover,
          gate: mode.indexGate,
          reserveObserver: mode.reserveObserver,
        }),
      describe: ({ type }) => ({ ...step, outcome: type }),
      failure: { ...step, outcome: "failed" },
    });
    if (outcome.type === "deferred") {
      return outcome;
    }
  } else {
    await reportIndexCutoverReadiness({
      connection,
      cutover,
      report: mode.report,
    });
    const stagedState = await readIndexState(connection, cutover.staged);
    const stagedArtifacts = await readReindexArtifacts(
      connection,
      cutover.staged,
    );
    for (const artifact of stagedArtifacts) {
      assertIndexDefinition(cutover.staged, artifact);
      if (artifact.isValid) {
        panic(
          `Required migration index ${cutover.staged.name} introduced by ${cutover.introducedBy} has a valid reindex artifact`,
        );
      }
    }
    if (stagedArtifacts.length > 0) {
      reportPendingStep({
        report: mode.report,
        step: {
          kind: "cutover",
          name: cutover.final.name,
          introducedBy: cutover.introducedBy,
        },
        reason: "staged reindex artifacts remain",
      });
    }
    if (stagedState.type === "present") {
      assertIndexDefinition(cutover.staged, stagedState);
      reportPendingStep({
        report: mode.report,
        step: {
          kind: "cutover",
          name: cutover.final.name,
          introducedBy: cutover.introducedBy,
        },
        reason: "staged index remains",
      });
    }
  }
  return await processOnlineIndexCutoverAt({
    connection,
    mode,
    offset: offset + 1,
  });
};

type OnlineRepairWalkOptions = {
  connection: OnlineMigrationConnection;
  mode: OnlineMigrationMode;
  repairs: readonly OnlineRepair[];
  log: NonNullable<OnlineMigrationOptions["log"]>;
  offset?: number;
};

const processOnlineRepairAt = async ({
  connection,
  mode,
  repairs,
  log,
  offset = 0,
}: OnlineRepairWalkOptions): Promise<OnlineMigrationOutcome> => {
  const repair = repairs.at(offset);
  if (!repair) {
    return COMPLETE;
  }

  const completion = await repair.readCompletion(connection);
  if (mode.operation === "validate") {
    if (completion.type !== "complete") {
      reportPendingStep({
        report: mode.report,
        step: {
          kind: "repair",
          name: repair.name,
          introducedBy: repair.introducedBy,
        },
        reason: completion.reason,
      });
    }
    return await processOnlineRepairAt({
      connection,
      mode,
      repairs,
      log,
      offset: offset + 1,
    });
  }
  if (completion.type !== "complete") {
    const step = {
      event: "migrate.online_step_duration",
      kind: "repair",
      name: repair.name,
    } as const;
    // The postconditions run inside the timed work, so a repair they reject
    // is reported as failed, never as pending.
    const settled = await timed({
      timing: mode.timing,
      work: async (): Promise<
        | OnlineRepairCompletion
        | Extract<OnlineMigrationOutcome, { type: "deferred" }>
      > => {
        const attempt = await Result.tryPromise({
          try: async () =>
            await repair.repair(
              connection,
              createOnlineTableGate({
                connection,
                gate: mode.indexGate,
                reserveObserver: mode.reserveObserver,
              }),
            ),
          catch: (cause: unknown) => cause,
        });
        await connection.execute(ONLINE_MIGRATION_LOCK_TIMEOUT_SQL);
        if (
          Result.isError(attempt) &&
          !(attempt.error instanceof BackfillHeldError)
        ) {
          throw attempt.error;
        }
        // A deferred validation leaves its constraint NOT VALID, so the next
        // run reads the repair incomplete and calls it again.
        if (Result.isOk(attempt) && attempt.value.type === "deferred") {
          return attempt.value;
        }
        const after = await repair.readCompletion(connection);
        if (Result.isError(attempt) && after.type !== "pending") {
          return panic(
            `Online repair ${repair.name}: hold has no durable pending checkpoint`,
          );
        }
        assertRepairDeployable(repair, after);
        return after;
      },
      describe: ({ type }) => ({
        ...step,
        outcome: type === "complete" || type === "deferred" ? type : "pending",
      }),
      failure: { ...step, outcome: "failed" },
    });
    if (settled.type === "deferred") {
      return settled;
    }
    if (settled.type === "pending") {
      log({
        event: "online_repair_pending",
        repair: repair.name,
        completion: settled,
      });
    }
  } else {
    assertRepairDeployable(repair, completion);
  }
  return await processOnlineRepairAt({
    connection,
    mode,
    repairs,
    log,
    offset: offset + 1,
  });
};

const assertRepairDeployable = (
  { name }: OnlineRepair,
  completion: OnlineRepairCompletion,
): void => {
  switch (completion.type) {
    case "complete":
    case "pending":
      return;
    case "incomplete":
      return panic(
        `Online repair ${name} is not complete: ${completion.reason}`,
        completion.cause,
      );
    default:
      completion satisfies never;
      return panic(`Online repair ${name}: unexpected completion state`);
  }
};

const retireReplacedIndexAt = async (
  connection: OnlineMigrationConnection,
  repair: Extract<OnlineMigrationMode, { operation: "repair" }>,
  offset = 0,
): Promise<OnlineMigrationOutcome> => {
  const replacement = ONLINE_INDEX_REPLACEMENTS.at(offset);
  if (!replacement) {
    return COMPLETE;
  }

  const step = {
    event: "migrate.online_step_duration",
    kind: "replacement_drop",
    name: replacement.legacyName,
  } as const;
  const outcome = await timed({
    timing: repair.timing,
    work: async () => {
      await assertReplacementIndexAt(connection, replacement);
      return await retireOnlineIndex({
        connection,
        index: {
          name: replacement.legacyName,
          tableName: replacementTableName(replacement),
        },
        gate: repair.indexGate,
        reserveObserver: repair.reserveObserver,
      });
    },
    describe: ({ type }) => ({ ...step, outcome: type }),
    failure: { ...step, outcome: "failed" },
  });
  if (outcome.type === "deferred") {
    return outcome;
  }
  return await retireReplacedIndexAt(connection, repair, offset + 1);
};

/** A replaced index lives on the table its replacements cover. */
export const replacementTableName = ({
  legacyName,
  replacementNames,
}: OnlineIndexReplacement): string => {
  const tableNames = new Set(
    replacementNames.map(
      (replacementName) =>
        ONLINE_MIGRATION_INDEXES.find(({ name }) => name === replacementName)
          ?.tableName ??
        panic(
          `Replacement index ${replacementName} is not registered for online validation`,
        ),
    ),
  );
  const [tableName, ...others] = tableNames;
  if (tableName === undefined || others.length > 0) {
    return panic(
      `Replaced index ${legacyName} needs replacements on exactly one table`,
    );
  }
  return tableName;
};

type RetireOnlineIndexOptions = {
  connection: OnlineMigrationConnection;
  index: Pick<RequiredMigrationIndex, "name" | "tableName">;
  gate: OnlineIndexGateOptions;
  reserveObserver: () => Promise<OnlineMigrationConnection>;
};

/**
 * Drops a replaced index. The drop waits for every transaction on the table,
 * so it runs through the index gate like a build: a drop the gate holds or
 * cancels defers the phase, and keeping the index meanwhile only costs
 * writes. A drop cancelled after PostgreSQL marked the index invalid leaves
 * it `INVALID`; the next run finds it present and drops it the same way.
 */
export const retireOnlineIndex = async ({
  connection,
  index,
  gate,
  reserveObserver,
}: RetireOnlineIndexOptions): Promise<OnlineMigrationOutcome> => {
  // Once retired, the step reads the catalog and nothing else, so a held gate
  // never defers a phase over an index that is already gone.
  if ((await readIndexState(connection, index)).type === "missing") {
    return COMPLETE;
  }
  return await runGatedTableWork({
    connection,
    gate,
    reserveObserver,
    target: index,
    kind: "index_repair",
    work: async (session) => {
      await session.run(dropIndexConcurrently(index, { ifExists: true }));
    },
  });
};

type ReportOnlineReplacementsOptions = {
  connection: OnlineMigrationConnection;
  report: OnlineMigrationStartupReport;
  offset?: number;
};

const reportOnlineReplacements = async ({
  connection,
  report,
  offset = 0,
}: ReportOnlineReplacementsOptions): Promise<void> => {
  const replacement = ONLINE_INDEX_REPLACEMENTS.at(offset);
  if (!replacement) {
    return;
  }
  const index = ONLINE_MIGRATION_INDEXES.find(({ name }) =>
    replacement.replacementNames.includes(name),
  );
  if (!index) {
    panic(
      `Online replacement ${replacement.legacyName} has no registered index`,
    );
  }
  const legacy = { ...index, name: replacement.legacyName };
  const state = await readIndexState(connection, legacy);
  const artifacts = await readReindexArtifacts(connection, legacy);
  if (artifacts.some(({ isValid }) => isValid)) {
    panic(
      `Required migration index ${legacy.name} ${typeof replacement.introducedBy === "string" ? `introduced by ${replacement.introducedBy}` : `owned by ${replacement.introducedBy.owner}`} has a valid reindex artifact`,
    );
  }
  if (state.type === "present" || artifacts.length > 0) {
    reportPendingStep({
      report,
      step: {
        kind: "replacement_drop",
        name: legacy.name,
        introducedBy: replacement.introducedBy,
      },
      reason: "retired index remains",
    });
  }
  await reportOnlineReplacements({ connection, report, offset: offset + 1 });
};

const assertReplacementIndexAt = async (
  connection: OnlineMigrationConnection,
  replacement: OnlineIndexReplacement,
  offset = 0,
): Promise<void> => {
  const replacementName = replacement.replacementNames.at(offset);
  if (!replacementName) {
    return;
  }
  const index = ONLINE_MIGRATION_INDEXES.find(
    ({ name }) => name === replacementName,
  );
  if (!index) {
    panic(
      `Replacement index ${replacementName} is not registered for online validation`,
    );
  }

  await assertIndexReady(connection, index);
  await assertReplacementIndexAt(connection, replacement, offset + 1);
};

const parsePresentIndexState = (row: unknown): PresentIndexState => {
  if (
    typeof row !== "object" ||
    row === null ||
    !("definition" in row) ||
    typeof row.definition !== "string" ||
    !("isReady" in row) ||
    typeof row.isReady !== "boolean" ||
    !("isUnique" in row) ||
    typeof row.isUnique !== "boolean" ||
    !("isValid" in row) ||
    typeof row.isValid !== "boolean" ||
    !("name" in row) ||
    typeof row.name !== "string"
  ) {
    panic("Online migration index state has an invalid shape");
  }

  return {
    definition: row.definition,
    isReady: row.isReady,
    isUnique: row.isUnique,
    isValid: row.isValid,
    name: row.name,
    type: "present",
  };
};

const readIndexState = async (
  connection: Pick<OnlineMigrationConnection, "query">,
  { name, tableName }: Pick<RequiredMigrationIndex, "name" | "tableName">,
): Promise<OnlineIndexState> => {
  const row = (
    await connection.query(READ_INDEX_STATE_SQL, ["public", name, tableName])
  ).at(0);
  return row === undefined ? { type: "missing" } : parsePresentIndexState(row);
};

const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;

const reindexArtifactPrefix = (name: string, suffix: "_ccnew" | "_ccold") =>
  `${name.slice(0, POSTGRES_IDENTIFIER_MAX_LENGTH - suffix.length)}${suffix}`;

const readReindexArtifacts = async (
  connection: Pick<OnlineMigrationConnection, "query">,
  { name, tableName }: RequiredMigrationIndex,
): Promise<PresentIndexState[]> =>
  (
    await connection.query(READ_REINDEX_ARTIFACTS_SQL, [
      "public",
      tableName,
      reindexArtifactPrefix(name, "_ccnew"),
      reindexArtifactPrefix(name, "_ccold"),
    ])
  ).map(parsePresentIndexState);

const definitionBody = (definition: string): string => {
  const bodyStart = definition.indexOf(" ON ");
  if (bodyStart === -1) {
    panic("Online migration index definition has an invalid shape");
  }
  return definition.slice(bodyStart + 1);
};

const assertIndexDefinition = (
  index: RequiredMigrationIndex,
  state: PresentIndexState,
): void => {
  if (!hasExpectedIndexDefinition(index, state)) {
    panic(
      `Required migration index ${index.name} has an unexpected definition`,
    );
  }
};

const hasExpectedIndexDefinition = (
  index: RequiredMigrationIndex,
  state: PresentIndexState,
): boolean =>
  state.isUnique === index.isUnique &&
  definitionBody(state.definition) === index.definitionBody;

const assertNoReindexArtifacts = async (
  connection: OnlineMigrationConnection,
  index: RequiredMigrationIndex,
): Promise<void> => {
  const artifacts = await readReindexArtifacts(connection, index);
  if (artifacts.length > 0) {
    panic(`Required migration index ${index.name} has reindex artifacts`);
  }
};

/** Runs only inside gated index work: each artifact drop waits for the table. */
const cleanupFailedReindexArtifacts = async (
  session: GatedTableSession,
  index: RequiredMigrationIndex,
): Promise<void> => {
  const artifacts = await readReindexArtifacts(session, index);
  await cleanupReindexArtifactAt(session, index, artifacts);
};

const cleanupReindexArtifactAt = async (
  session: GatedTableSession,
  index: RequiredMigrationIndex,
  artifacts: readonly PresentIndexState[],
  offset = 0,
): Promise<void> => {
  const artifact = artifacts.at(offset);
  if (!artifact) {
    return;
  }

  assertIndexDefinition(index, artifact);
  if (artifact.isValid) {
    panic(
      `Required migration index ${index.name} has a valid reindex artifact`,
    );
  }
  await session.run(
    dropIndexConcurrently(
      { name: artifact.name, tableName: index.tableName },
      { ifExists: false },
    ),
  );
  await cleanupReindexArtifactAt(session, index, artifacts, offset + 1);
};

type ReportIndexReadinessOptions = {
  connection: OnlineMigrationConnection;
  index: RequiredMigrationIndex & { introducedBy: OnlineStepIntroduction };
  report: OnlineMigrationStartupReport;
  kind: "index" | "cutover";
};

const reportIndexReadiness = async ({
  connection,
  index,
  report,
  kind,
}: ReportIndexReadinessOptions): Promise<void> => {
  const state = await readIndexState(connection, index);
  if (state.type === "present") {
    assertIndexDefinition(index, state);
  }
  const artifacts = await readReindexArtifacts(connection, index);
  for (const artifact of artifacts) {
    assertIndexDefinition(index, artifact);
    if (artifact.isValid) {
      panic(
        `Required migration index ${index.name} ${typeof index.introducedBy === "string" ? `introduced by ${index.introducedBy}` : `owned by ${index.introducedBy.owner}`} has a valid reindex artifact`,
      );
    }
  }
  if (
    state.type === "missing" ||
    !state.isReady ||
    !state.isValid ||
    artifacts.length > 0
  ) {
    reportPendingStep({
      report,
      step: { kind, name: index.name, introducedBy: index.introducedBy },
      reason:
        state.type === "missing"
          ? "index is missing"
          : "index is not ready or has reindex artifacts",
    });
  }
};

type ReportIndexCutoverReadinessOptions = {
  connection: OnlineMigrationConnection;
  cutover: OnlineIndexCutover;
  report: OnlineMigrationStartupReport;
};

const reportIndexCutoverReadiness = async ({
  connection,
  cutover: { final, introducedBy, legacy },
  report,
}: ReportIndexCutoverReadinessOptions): Promise<void> => {
  const state = await readIndexState(connection, final);
  const finalHasExpectedDefinition =
    state.type === "present" && hasExpectedIndexDefinition(final, state);
  const finalHasLegacyDefinition =
    state.type === "present" && hasExpectedIndexDefinition(legacy, state);
  if (
    state.type === "present" &&
    !finalHasExpectedDefinition &&
    !finalHasLegacyDefinition
  ) {
    assertIndexDefinition(final, state);
  }

  const artifacts = await readReindexArtifacts(connection, final);
  for (const artifact of artifacts) {
    assertIndexDefinition(final, artifact);
    if (artifact.isValid) {
      panic(
        `Required migration index ${final.name} introduced by ${introducedBy} has a valid reindex artifact`,
      );
    }
  }
  if (
    state.type === "missing" ||
    finalHasLegacyDefinition ||
    !state.isReady ||
    !state.isValid ||
    artifacts.length > 0
  ) {
    let reason = "index is not ready or has reindex artifacts";
    if (state.type === "missing") {
      reason = "index is missing";
    } else if (finalHasLegacyDefinition) {
      reason = "final index still has its legacy definition";
    }
    reportPendingStep({
      report,
      step: { kind: "cutover", name: final.name, introducedBy },
      reason,
    });
  }
};

const assertIndexReady = async (
  connection: OnlineMigrationConnection,
  index: RequiredMigrationIndex,
): Promise<void> => {
  const state = await readIndexState(connection, index);
  if (state.type === "missing") {
    panic(`Required migration index ${index.name} is missing`);
  }
  assertIndexDefinition(index, state);
  if (!state.isValid || !state.isReady) {
    panic(`Required migration index ${index.name} is not ready`);
  }
  await assertNoReindexArtifacts(connection, index);
};

type EnsureOnlineIndexOptions = {
  connection: OnlineMigrationConnection;
  index: OnlineIndexDeclaration;
  gate: OnlineIndexGateOptions;
  reserveObserver: () => Promise<OnlineMigrationConnection>;
};

export const ensureOnlineIndexValid = async ({
  connection,
  index,
  gate,
  reserveObserver,
}: EnsureOnlineIndexOptions): Promise<OnlineMigrationOutcome> => {
  const initialState = await readIndexState(connection, index);
  if (initialState.type === "present") {
    assertIndexDefinition(index, initialState);
    if (
      initialState.isValid &&
      initialState.isReady &&
      (await readReindexArtifacts(connection, index)).length === 0
    ) {
      return COMPLETE;
    }
  } else if (!declaresOnlineBuild(index)) {
    panic(`Required migration index ${index.name} is missing`);
  }
  const outcome = await runGatedTableWork({
    connection,
    gate,
    reserveObserver,
    target: index,
    kind: initialState.type === "present" ? "index_repair" : "index_build",
    work: async (session) => {
      await cleanupFailedReindexArtifacts(session, index);
      const state = await readIndexState(session, index);
      if (state.type === "present") {
        assertIndexDefinition(index, state);
        if (state.isValid && state.isReady) {
          return;
        }
        // An interrupted concurrent build can leave the index ready but
        // invalid: PostgreSQL still maintains it, and a unique one still
        // rejects duplicates. REINDEX builds the copy beside it and swaps
        // only once the copy is valid, so enforcement never lapses; a
        // DROP before CREATE would let a duplicate commit in between.
        await session.run(reindexIndexConcurrently(index));
        return;
      }
      if (!declaresOnlineBuild(index)) {
        panic(`Required migration index ${index.name} is missing`);
      }
      await session.run(createIndexConcurrently(index));
    },
  });
  if (outcome.type === "complete") {
    await assertIndexReady(connection, index);
  }
  return outcome;
};

type CompleteIndexCutoverOptions = {
  connection: OnlineMigrationConnection;
  cutover: OnlineIndexCutover;
  gate: OnlineIndexGateOptions;
  reserveObserver: () => Promise<OnlineMigrationConnection>;
};

export const completeIndexCutover = async ({
  connection,
  cutover: { final, staged },
  gate: indexGate,
  reserveObserver,
}: CompleteIndexCutoverOptions): Promise<OnlineMigrationOutcome> => {
  const finalState = await readIndexState(connection, final);

  if (finalState.type === "present") {
    const finalIsReady =
      hasExpectedIndexDefinition(final, finalState) &&
      finalState.isValid &&
      finalState.isReady;

    if (finalIsReady) {
      const stagedState = await readIndexState(connection, staged);
      if (stagedState.type === "present") {
        assertIndexDefinition(staged, stagedState);
      }
      const artifacts = await readReindexArtifacts(connection, final);
      if (stagedState.type === "present" || artifacts.length > 0) {
        const cleanup = await runGatedTableWork({
          connection,
          gate: indexGate,
          reserveObserver,
          target: final,
          kind: "index_repair",
          work: async (session) => {
            await cleanupFailedReindexArtifacts(session, final);
            if (stagedState.type === "present") {
              await session.run(
                dropIndexConcurrently(staged, { ifExists: false }),
              );
            }
          },
        });
        if (cleanup.type === "deferred") {
          return cleanup;
        }
      }
      await assertIndexReady(connection, final);
      return COMPLETE;
    }
  }

  const stagedOutcome = await ensureOnlineIndexValid({
    connection,
    index: staged,
    gate: indexGate,
    reserveObserver,
  });
  if (stagedOutcome.type === "deferred") {
    return stagedOutcome;
  }

  // The drop of a stale final index and the rename run as one gated unit, so
  // readers lose the final name only between two statements of one session.
  // A drop cancelled into INVALID leaves the final index present and not
  // ready, and a deferred rename leaves the staged index in place, so the
  // next run takes this path again either way.
  const renamed = await runGatedTableWork({
    connection,
    gate: indexGate,
    reserveObserver,
    target: final,
    kind: "index_repair",
    work: async (session) => {
      if (finalState.type === "present") {
        await session.run(dropIndexConcurrently(final, { ifExists: false }));
      }
      await session.run(renameIndex({ from: staged, to: final }));
    },
  });
  if (renamed.type === "deferred") {
    return renamed;
  }
  await assertIndexReady(connection, final);
  return COMPLETE;
};
