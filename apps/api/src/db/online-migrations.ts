import { panic, Result } from "better-result";

import { sleep } from "@stll/concurrency/sleep";

import { CASE_LAW_COVERAGE_INDEX } from "@/api/lib/case-law/coverage-index";
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
  AGENT_SKILL_BINDING_CONSTRAINT_VALIDATIONS,
  AGENT_SKILL_BINDING_CONSTRAINTS,
} from "./agent-skill-binding-constraint-validation";
import { BackfillHeldError } from "./backfill-runtime";
import { BETTER_AUTH_OAUTH_RESOURCE_REPAIR } from "./better-auth-oauth-resource-repair";
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
import { ENTITY_FEATURE_GATE_REPAIR } from "./entity-feature-gate-repair";
import {
  INVOICE_LANGUAGE_CONSTRAINT_VALIDATIONS,
  INVOICE_LANGUAGE_CONSTRAINTS,
} from "./invoice-language-constraint-validation";
import {
  LIST_VERIFICATION_CONSTRAINT_VALIDATION,
  LIST_VERIFICATION_CONSTRAINTS,
} from "./list-verification-constraint-validation";
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
} from "./online-migration-connection";
import {
  ORGANIZATION_ACCESS_STATE_CONSTRAINT_VALIDATION,
  ORGANIZATION_ACCESS_STATE_CONSTRAINTS,
} from "./organization-access-state-constraint-validation";
import {
  READER_ANNOTATION_CLAIM_CONSTRAINT_VALIDATIONS,
  READER_ANNOTATION_CLAIM_CONSTRAINTS,
} from "./reader-annotation-claim-constraint-validation";
import {
  SANCTIONS_MONITORING_CONSTRAINT_VALIDATIONS,
  SANCTIONS_MONITORING_CONSTRAINTS,
} from "./sanctions-monitoring-constraint-validation";
import {
  USER_LOCALE_CONSTRAINT,
  USER_LOCALE_CONSTRAINT_VALIDATION,
} from "./user-locale-constraint-validation";

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

type OnlineIndex = OnlineIndexDeclaration;

const PUBLISHED_CASE_LAW_DECISION_INDEX_PREDICATE =
  publishedCaseLawDecisionIndexPredicateSql();
const PUBLISHED_CASE_LAW_DECISION_INDEX_DEFINITION =
  publishedCaseLawDecisionIndexDefinitionPredicateSql();

export const ONLINE_MIGRATION_INDEXES: readonly OnlineIndex[] = [
  CASE_LAW_PARSE_PENDING_INDEX,
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "agent_skills_bound_workspace_idx" ON public."agent_skills" (bound_workspace_id) WHERE bound_workspace_id IS NOT NULL',
    definitionBody:
      "ON public.agent_skills USING btree (bound_workspace_id) WHERE (bound_workspace_id IS NOT NULL)",
    isUnique: false,
    name: "agent_skills_bound_workspace_idx",
    tableName: "agent_skills",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "agent_skills_bound_client_idx" ON public."agent_skills" (bound_client_id) WHERE bound_client_id IS NOT NULL',
    definitionBody:
      "ON public.agent_skills USING btree (bound_client_id) WHERE (bound_client_id IS NOT NULL)",
    isUnique: false,
    name: "agent_skills_bound_client_idx",
    tableName: "agent_skills",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "legislation_documents_work_version_lang_idx" ON public."legislation_documents" (source_id, eli, version_valid_from, language) WHERE version_valid_from IS NOT NULL',
    definitionBody:
      "ON public.legislation_documents USING btree (source_id, eli, version_valid_from, language) WHERE (version_valid_from IS NOT NULL)",
    isUnique: false,
    name: "legislation_documents_work_version_lang_idx",
    tableName: "legislation_documents",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "legislation_documents_publisher_identity_idx" ON public."legislation_documents" (source_id, eli, language, publisher_expression_id) WHERE identity_mode = \'publisher-expression\'',
    definitionBody:
      "ON public.legislation_documents USING btree (source_id, eli, language, publisher_expression_id) WHERE ((identity_mode)::text = 'publisher-expression'::text)",
    isUnique: true,
    name: "legislation_documents_publisher_identity_idx",
    tableName: "legislation_documents",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "legislation_documents_legacy_version_lang_idx" ON public."legislation_documents" (source_id, eli, version_valid_from, language) WHERE identity_mode = \'legacy-window\' AND version_valid_from IS NOT NULL',
    definitionBody:
      "ON public.legislation_documents USING btree (source_id, eli, version_valid_from, language) WHERE (((identity_mode)::text = 'legacy-window'::text) AND (version_valid_from IS NOT NULL))",
    isUnique: true,
    name: "legislation_documents_legacy_version_lang_idx",
    tableName: "legislation_documents",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "legislation_documents_legacy_current_lang_idx" ON public."legislation_documents" (source_id, eli, language) WHERE identity_mode = \'legacy-window\' AND version_valid_from IS NULL',
    definitionBody:
      "ON public.legislation_documents USING btree (source_id, eli, language) WHERE (((identity_mode)::text = 'legacy-window'::text) AND (version_valid_from IS NULL))",
    isUnique: true,
    name: "legislation_documents_legacy_current_lang_idx",
    tableName: "legislation_documents",
  },
  {
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
  ...MONITORING_SESSION_INDEXES,
  ...Object.values(CHAT_CONTENT_V3_SOURCES).map(({ table: tableName }) => ({
    createSql: `CREATE INDEX CONCURRENTLY "${tableName}_content_v3_pending_idx" ON public."${tableName}" (id) WHERE (content -> 'version') IS DISTINCT FROM '3'::jsonb`,
    definitionBody: `ON public.${tableName} USING btree (id) WHERE ((content -> 'version'::text) IS DISTINCT FROM '3'::jsonb)`,
    isUnique: false,
    name: `${tableName}_content_v3_pending_idx`,
    tableName,
  })),
  CASE_LAW_COVERAGE_INDEX,
  // Reviewed doctrine per cited decision: few rows carry a finding.
  {
    createSql: `CREATE INDEX CONCURRENTLY "case_law_citations_doctrine_cited_idx" ON public."case_law_citations" USING btree ("cited_decision_id") WHERE "doctrinal_treatment" IN ('distinguishes', 'limits')`,
    definitionBody:
      "ON public.case_law_citations USING btree (cited_decision_id) WHERE ((doctrinal_treatment)::text = ANY ((ARRAY['distinguishes'::character varying, 'limits'::character varying])::text[]))",
    isUnique: false,
    name: "case_law_citations_doctrine_cited_idx",
    tableName: "case_law_citations",
  },
  // A provision's subtree of citing rows as one byte-ordered anchor range.
  {
    createSql: `CREATE INDEX CONCURRENTLY "case_law_provision_citations_work_subtree_idx" ON public."case_law_provision_citations" USING btree ("jurisdiction", "work_identifier", "anchor" COLLATE "C")`,
    definitionBody:
      'ON public.case_law_provision_citations USING btree (jurisdiction, work_identifier, anchor COLLATE "C")',
    isUnique: false,
    name: "case_law_provision_citations_work_subtree_idx",
    tableName: "case_law_provision_citations",
  },
  {
    createSql: `CREATE INDEX CONCURRENTLY "case_law_provision_citations_eli_subtree_idx" ON public."case_law_provision_citations" USING btree ("jurisdiction", "work_eli", "anchor" COLLATE "C") WHERE "work_eli" IS NOT NULL`,
    definitionBody:
      'ON public.case_law_provision_citations USING btree (jurisdiction, work_eli, anchor COLLATE "C") WHERE (work_eli IS NOT NULL)',
    isUnique: false,
    name: "case_law_provision_citations_eli_subtree_idx",
    tableName: "case_law_provision_citations",
  },
  // Bounded cross-publisher ruling lookup before a decision insert.
  {
    createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_republished_ruling_idx" ON public."case_law_decisions" ("country", "court", "docket_family_key", "id") WHERE "docket_family_key" IS NOT NULL`,
    definitionBody:
      "ON public.case_law_decisions USING btree (country, court, docket_family_key, id) WHERE (docket_family_key IS NOT NULL)",
    isUnique: false,
    name: "case_law_decisions_republished_ruling_idx",
    tableName: "case_law_decisions",
  },
  {
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
    isUnique: false,
    name: "apikey_personal_owner_keyset_idx",
    tableName: "apikey",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "sanctions_contact_matches_org_open_cursor_idx" ON public."sanctions_contact_matches" USING btree ("organization_id", "state", "disposition", "contact_id", "source_id", "source_entry_id")',
    definitionBody:
      "ON public.sanctions_contact_matches USING btree (organization_id, state, disposition, contact_id, source_id, source_entry_id)",
    isUnique: false,
    name: "sanctions_contact_matches_org_open_cursor_idx",
    tableName: "sanctions_contact_matches",
  },
  {
    createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_country_date_published_idx" ON public."case_law_decisions" USING btree ("country", coalesce("decision_date", '-infinity'::date), "id") WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_PREDICATE}`,
    definitionBody: `ON public.case_law_decisions USING btree (country, COALESCE(decision_date, '-infinity'::date), id) WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_DEFINITION}`,
    isUnique: false,
    name: "case_law_decisions_country_date_published_idx",
    tableName: "case_law_decisions",
  },
  {
    createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_citation_candidate_published_idx" ON public."case_law_decisions" USING btree ("citation_key", "country", "decision_date", "id") WHERE "citation_key" IS NOT NULL AND ${PUBLISHED_CASE_LAW_DECISION_INDEX_PREDICATE}`,
    definitionBody: `ON public.case_law_decisions USING btree (citation_key, country, decision_date, id) WHERE ((citation_key IS NOT NULL) AND ${PUBLISHED_CASE_LAW_DECISION_INDEX_DEFINITION})`,
    isUnique: false,
    name: "case_law_decisions_citation_candidate_published_idx",
    tableName: "case_law_decisions",
  },
  {
    createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_source_arrivals_published_idx" ON public."case_law_decisions" USING btree ("source_id", "created_at") WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_PREDICATE}`,
    definitionBody: `ON public.case_law_decisions USING btree (source_id, created_at) WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_DEFINITION}`,
    isUnique: false,
    name: "case_law_decisions_source_arrivals_published_idx",
    tableName: "case_law_decisions",
  },
  {
    createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_sitemap_shard_published_idx" ON public."case_law_decisions" USING btree ("country", "decision_date", "source_id", "updated_at", "id") WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_PREDICATE}`,
    definitionBody: `ON public.case_law_decisions USING btree (country, decision_date, source_id, updated_at, id) WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_DEFINITION}`,
    isUnique: false,
    name: "case_law_decisions_sitemap_shard_published_idx",
    tableName: "case_law_decisions",
  },
  {
    createSql: `CREATE INDEX CONCURRENTLY "case_law_decisions_search_candidate_published_idx" ON public."case_law_decisions" USING btree ("id", "country", "source_id", "court", "decision_date", "decision_type", "language", "citation_authority", "language_group_key") WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_PREDICATE}`,
    definitionBody: `ON public.case_law_decisions USING btree (id, country, source_id, court, decision_date, decision_type, language, citation_authority, language_group_key) WHERE ${PUBLISHED_CASE_LAW_DECISION_INDEX_DEFINITION}`,
    isUnique: false,
    name: "case_law_decisions_search_candidate_published_idx",
    tableName: "case_law_decisions",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "sanctions_screening_events_org_cursor_idx" ON public."sanctions_screening_events" USING btree ("organization_id", "created_at", "id")',
    definitionBody:
      "ON public.sanctions_screening_events USING btree (organization_id, created_at, id)",
    isUnique: false,
    name: "sanctions_screening_events_org_cursor_idx",
    tableName: "sanctions_screening_events",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "contacts_org_id_unique" ON public."contacts" USING btree ("organization_id", "id")',
    definitionBody: "ON public.contacts USING btree (organization_id, id)",
    isUnique: true,
    name: "contacts_org_id_unique",
    tableName: "contacts",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "rate_entries_table_role_from_idx" ON public."rate_entries" USING btree ("rate_table_id", "role", "effective_from")',
    definitionBody:
      "ON public.rate_entries USING btree (rate_table_id, role, effective_from)",
    isUnique: false,
    name: "rate_entries_table_role_from_idx",
    tableName: "rate_entries",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "session_priorTokenHash_idx" ON public."session" USING btree ("prior_token_hash")',
    definitionBody: "ON public.session USING btree (prior_token_hash)",
    isUnique: true,
    name: "session_priorTokenHash_idx",
    tableName: "session",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "time_entries_org_status_date_id_idx" ON public."time_entries" USING btree ("organization_id", "status", "date_worked", "id")',
    definitionBody:
      "ON public.time_entries USING btree (organization_id, status, date_worked, id)",
    isUnique: false,
    name: "time_entries_org_status_date_id_idx",
    tableName: "time_entries",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "time_entries_approval_queue_idx" ON public."time_entries" USING btree ("organization_id", "approver_user_id", "status", "date_worked", "id") WHERE "status" = \'draft\'',
    definitionBody:
      "ON public.time_entries USING btree (organization_id, approver_user_id, status, date_worked, id) WHERE (status = 'draft'::text)",
    isUnique: false,
    name: "time_entries_approval_queue_idx",
    tableName: "time_entries",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "invoices_id_workspace_unique" ON public."invoices" USING btree ("id", "workspace_id")',
    definitionBody: "ON public.invoices USING btree (id, workspace_id)",
    isUnique: true,
    name: "invoices_id_workspace_unique",
    tableName: "invoices",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "invoices_ws_original_idx" ON public."invoices" USING btree ("workspace_id", "original_invoice_id")',
    definitionBody:
      "ON public.invoices USING btree (workspace_id, original_invoice_id)",
    isUnique: false,
    name: "invoices_ws_original_idx",
    tableName: "invoices",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "legal_lists_sample_workspace_uidx" ON public."legal_lists" USING btree ("workspace_id") WHERE "sample_case" IS NOT NULL',
    definitionBody:
      "ON public.legal_lists USING btree (workspace_id) WHERE (sample_case IS NOT NULL)",
    isUnique: true,
    name: "legal_lists_sample_workspace_uidx",
    tableName: "legal_lists",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "case_law_decisions_provision_scope_cursor_idx" ON public."case_law_decisions" USING btree ("country", "language", "id")',
    definitionBody:
      "ON public.case_law_decisions USING btree (country, language, id)",
    isUnique: false,
    name: "case_law_decisions_provision_scope_cursor_idx",
    tableName: "case_law_decisions",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "case_law_provision_extractions_jurisdiction_due_idx" ON public."case_law_provision_extractions" USING btree ("jurisdiction", "lane", "due_at", "decision_id") WHERE "due_at" IS NOT NULL AND "work_status" <> \'blocked\'',
    definitionBody:
      "ON public.case_law_provision_extractions USING btree (jurisdiction, lane, due_at, decision_id) WHERE ((due_at IS NOT NULL) AND (work_status <> 'blocked'::text))",
    isUnique: false,
    name: "case_law_provision_extractions_jurisdiction_due_idx",
    tableName: "case_law_provision_extractions",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "case_law_provision_extractions_pending_idx" ON public."case_law_provision_extractions" USING btree ("jurisdiction", "pending_since", "decision_id") WHERE "pending_since" IS NOT NULL',
    definitionBody:
      "ON public.case_law_provision_extractions USING btree (jurisdiction, pending_since, decision_id) WHERE (pending_since IS NOT NULL)",
    isUnique: false,
    name: "case_law_provision_extractions_pending_idx",
    tableName: "case_law_provision_extractions",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "case_law_provision_extractions_clock_seed_idx" ON public."case_law_provision_extractions" USING btree ("decision_id") WHERE "due_at" IS NOT NULL AND "pending_since" IS NULL',
    definitionBody:
      "ON public.case_law_provision_extractions USING btree (decision_id) WHERE ((due_at IS NOT NULL) AND (pending_since IS NULL))",
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
    isUnique: false,
    name: "case_law_decisions_docket_family_key_idx",
    tableName: "case_law_decisions",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "account_provider_account_id_uidx" ON public."account" USING btree ("provider_id", "account_id")',
    definitionBody: "ON public.account USING btree (provider_id, account_id)",
    isUnique: true,
    name: "account_provider_account_id_uidx",
    tableName: "account",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "chat_thread_compactions_memory_unmined_org_idx" ON public."chat_thread_compactions" USING btree ("memory_extraction_organization_id", "memory_extraction_consent_at", "memory_extraction_attempted_at" ASC NULLS FIRST, "created_at", "id") WHERE "memory_extraction_organization_id" IS NOT NULL AND "memory_extraction_consent_at" IS NOT NULL AND "memory_extracted_at" IS NULL AND "status" = \'active\'',
    definitionBody:
      "ON public.chat_thread_compactions USING btree (memory_extraction_organization_id, memory_extraction_consent_at, memory_extraction_attempted_at NULLS FIRST, created_at, id) WHERE ((memory_extraction_organization_id IS NOT NULL) AND (memory_extraction_consent_at IS NOT NULL) AND (memory_extracted_at IS NULL) AND ((status)::text = 'active'::text))",
    isUnique: false,
    name: "chat_thread_compactions_memory_unmined_org_idx",
    tableName: "chat_thread_compactions",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "organization_settings_memory_extraction_queue_idx" ON public."organization_settings" USING btree ("memory_extraction_scheduled_at", "organization_id") WHERE "memory_extraction_enabled" = true AND "memory_extraction_scheduled_at" IS NOT NULL',
    definitionBody:
      "ON public.organization_settings USING btree (memory_extraction_scheduled_at, organization_id) WHERE ((memory_extraction_enabled = true) AND (memory_extraction_scheduled_at IS NOT NULL))",
    isUnique: false,
    name: "organization_settings_memory_extraction_queue_idx",
    tableName: "organization_settings",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "workspaces_id_org_unq" ON public."workspaces" USING btree ("id", "organization_id")',
    definitionBody: "ON public.workspaces USING btree (id, organization_id)",
    isUnique: true,
    name: "workspaces_id_org_unq",
    tableName: "workspaces",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "entity_versions_id_entity_ws_uidx" ON public."entity_versions" USING btree ("id", "entity_id", "workspace_id")',
    definitionBody:
      "ON public.entity_versions USING btree (id, entity_id, workspace_id)",
    isUnique: true,
    name: "entity_versions_id_entity_ws_uidx",
    tableName: "entity_versions",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "entity_versions_entity_number_uidx" ON public."entity_versions" USING btree ("entity_id", "version_number")',
    definitionBody:
      "ON public.entity_versions USING btree (entity_id, version_number)",
    isUnique: true,
    name: "entity_versions_entity_number_uidx",
    tableName: "entity_versions",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "chat_messages_id_thread_uidx" ON public."chat_messages" USING btree ("id", "thread_id")',
    definitionBody: "ON public.chat_messages USING btree (id, thread_id)",
    isUnique: true,
    name: "chat_messages_id_thread_uidx",
    tableName: "chat_messages",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "time_entries_one_active_timer_per_user_idx" ON public."time_entries" USING btree ("user_id") WHERE "timer_started_at" IS NOT NULL',
    definitionBody:
      "ON public.time_entries USING btree (user_id) WHERE (timer_started_at IS NOT NULL)",
    isUnique: true,
    name: "time_entries_one_active_timer_per_user_idx",
    tableName: "time_entries",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "time_timers_running_org_id_idx" ON public."time_timers" USING btree ("organization_id", "id") WHERE "state" = \'running\'',
    definitionBody:
      "ON public.time_timers USING btree (organization_id, id) WHERE (state = 'running'::text)",
    isUnique: false,
    name: "time_timers_running_org_id_idx",
    tableName: "time_timers",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "time_timers_legacy_entry_uidx" ON public."time_timers" USING btree ("legacy_time_entry_id") WHERE "legacy_time_entry_id" IS NOT NULL',
    definitionBody:
      "ON public.time_timers USING btree (legacy_time_entry_id) WHERE (legacy_time_entry_id IS NOT NULL)",
    isUnique: true,
    name: "time_timers_legacy_entry_uidx",
    tableName: "time_timers",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "playbook_definitions_org_starter_id_uidx" ON public."playbook_definitions" USING btree ("organization_id", "starter_id") WHERE "starter_id" IS NOT NULL',
    definitionBody:
      "ON public.playbook_definitions USING btree (organization_id, starter_id) WHERE (starter_id IS NOT NULL)",
    isUnique: true,
    name: "playbook_definitions_org_starter_id_uidx",
    tableName: "playbook_definitions",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "templates_org_pack_template_uidx" ON public."templates" USING btree ("organization_id", (("origin"->>\'packId\')), (("origin"->>\'slug\'))) WHERE "origin_type" = \'bundled-pack\'',
    definitionBody:
      "ON public.templates USING btree (organization_id, ((origin ->> 'packId'::text)), ((origin ->> 'slug'::text))) WHERE (origin_type = 'bundled-pack'::text)",
    isUnique: true,
    name: "templates_org_pack_template_uidx",
    tableName: "templates",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "workspace_views_correspondence_uidx" ON public."workspace_views" USING btree ("workspace_id") WHERE ("layout" ->> \'type\') = \'correspondence\'',
    definitionBody:
      "ON public.workspace_views USING btree (workspace_id) WHERE ((layout ->> 'type'::text) = 'correspondence'::text)",
    isUnique: true,
    name: "workspace_views_correspondence_uidx",
    tableName: "workspace_views",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "report_exports_workspace_requester_created_idx" ON public."report_exports" USING btree ("workspace_id", "requested_by", "created_at", "id")',
    definitionBody:
      "ON public.report_exports USING btree (workspace_id, requested_by, created_at, id)",
    isUnique: false,
    name: "report_exports_workspace_requester_created_idx",
    tableName: "report_exports",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "folio_collab_rooms_workspace_source_version_idx" ON public."folio_collab_rooms" USING btree ("workspace_id", "source_version_id")',
    definitionBody:
      "ON public.folio_collab_rooms USING btree (workspace_id, source_version_id)",
    isUnique: false,
    name: "folio_collab_rooms_workspace_source_version_idx",
    tableName: "folio_collab_rooms",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "legislation_documents_country_slug_idx" ON public."legislation_documents" USING btree ("country", "slug") WHERE "slug" IS NOT NULL',
    definitionBody:
      "ON public.legislation_documents USING btree (country, slug) WHERE (slug IS NOT NULL)",
    isUnique: false,
    name: "legislation_documents_country_slug_idx",
    tableName: "legislation_documents",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "chat_turns_org_run_id_uidx" ON public."chat_turns" USING btree ("organization_id", "run_id") WHERE "run_id" IS NOT NULL',
    definitionBody:
      "ON public.chat_turns USING btree (organization_id, run_id) WHERE (run_id IS NOT NULL)",
    isUnique: true,
    name: "chat_turns_org_run_id_uidx",
    tableName: "chat_turns",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "legal_reader_answer_messages_answer_sequence_idx" ON public."legal_reader_answer_messages" USING btree ("answer_id", "sequence")',
    definitionBody:
      "ON public.legal_reader_answer_messages USING btree (answer_id, sequence)",
    isUnique: true,
    name: "legal_reader_answer_messages_answer_sequence_idx",
    tableName: "legal_reader_answer_messages",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "case_law_ingestion_failures_source_record_uidx" ON public."case_law_ingestion_failures" USING btree ("source_id", "record_identity") WHERE "record_identity" IS NOT NULL',
    definitionBody:
      "ON public.case_law_ingestion_failures USING btree (source_id, record_identity) WHERE (record_identity IS NOT NULL)",
    isUnique: true,
    name: "case_law_ingestion_failures_source_record_uidx",
    tableName: "case_law_ingestion_failures",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "correspondence_ws_source_entity_uidx" ON public."correspondence" USING btree ("workspace_id", "source_entity_id")',
    definitionBody:
      "ON public.correspondence USING btree (workspace_id, source_entity_id)",
    isUnique: true,
    name: "correspondence_ws_source_entity_uidx",
    tableName: "correspondence",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "correspondence_attachments_ws_entity_idx" ON public."correspondence_attachments" USING btree ("workspace_id", "entity_id")',
    definitionBody:
      "ON public.correspondence_attachments USING btree (workspace_id, entity_id)",
    isUnique: false,
    name: "correspondence_attachments_ws_entity_idx",
    tableName: "correspondence_attachments",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "sanctions_contact_marks_retry_idx" ON public."sanctions_contact_marks" USING btree ("next_attempt_at", "scheduled_at", "organization_id", "contact_id")',
    definitionBody:
      "ON public.sanctions_contact_marks USING btree (next_attempt_at, scheduled_at, organization_id, contact_id)",
    isUnique: false,
    name: "sanctions_contact_marks_retry_idx",
    tableName: "sanctions_contact_marks",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "sanctions_contact_marks_organization_retry_idx" ON public."sanctions_contact_marks" USING btree ("organization_id", "next_attempt_at", "scheduled_at", "contact_id")',
    definitionBody:
      "ON public.sanctions_contact_marks USING btree (organization_id, next_attempt_at, scheduled_at, contact_id)",
    isUnique: false,
    name: "sanctions_contact_marks_organization_retry_idx",
    tableName: "sanctions_contact_marks",
  },
  {
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
  final: RequiredMigrationIndex;
  staged: OnlineIndex;
};

export const ONLINE_MIGRATION_INDEX_CUTOVERS: readonly OnlineIndexCutover[] = [
  {
    final: {
      definitionBody:
        "ON public.case_law_decisions USING btree (updated_at DESC, id DESC)",
      isUnique: false,
      name: "case_law_decisions_updated_id_idx",
      tableName: "case_law_decisions",
    },
    staged: {
      createSql:
        'CREATE INDEX CONCURRENTLY "case_law_decisions_updated_id_idx_replacement" ON public."case_law_decisions" USING btree ("updated_at" DESC, "id" DESC)',
      definitionBody:
        "ON public.case_law_decisions USING btree (updated_at DESC, id DESC)",
      isUnique: false,
      name: "case_law_decisions_updated_id_idx_replacement",
      tableName: "case_law_decisions",
    },
  },
];

type OnlineIndexReplacement = {
  legacyName: string;
  replacementNames: readonly string[];
};

export const ONLINE_INDEX_REPLACEMENTS: readonly OnlineIndexReplacement[] = [
  {
    legacyName: "case_law_decisions_country_date_idx",
    replacementNames: ["case_law_decisions_country_date_published_idx"],
  },
  {
    legacyName: "case_law_decisions_source_arrivals_idx",
    replacementNames: ["case_law_decisions_source_arrivals_published_idx"],
  },
  {
    legacyName: "case_law_decisions_sitemap_shard_idx",
    replacementNames: ["case_law_decisions_sitemap_shard_published_idx"],
  },
  {
    legacyName: "case_law_decisions_search_candidate_idx",
    replacementNames: ["case_law_decisions_search_candidate_published_idx"],
  },
  {
    legacyName: "legislation_documents_eli_version_lang_idx",
    replacementNames: [
      "legislation_documents_work_version_lang_idx",
      "legislation_documents_publisher_identity_idx",
      "legislation_documents_legacy_version_lang_idx",
    ],
  },
  {
    legacyName: "legislation_documents_eli_current_lang_idx",
    replacementNames: [
      "legislation_documents_publisher_identity_idx",
      "legislation_documents_legacy_current_lang_idx",
    ],
  },
  {
    legacyName: "legal_reader_answer_messages_answer_idx",
    replacementNames: ["legal_reader_answer_messages_answer_sequence_idx"],
  },
  {
    legacyName: "case_law_decisions_document_pending_date_idx",
    replacementNames: [DOCUMENT_OUTSTANDING_DATE_INDEX.name],
  },
  {
    legacyName: "case_law_decisions_source_case_lang_idx",
    replacementNames: [
      "case_law_decisions_source_document_idx",
      "case_law_decisions_source_case_lang_null_idx",
    ],
  },
  // A provision's citing rows are its whole subtree, which the exact-anchor
  // walks cannot seek under the database collation.
  {
    legacyName: "case_law_provision_citations_work_anchor_idx",
    replacementNames: ["case_law_provision_citations_work_subtree_idx"],
  },
  {
    legacyName: "case_law_provision_citations_eli_anchor_idx",
    replacementNames: ["case_law_provision_citations_eli_subtree_idx"],
  },
  // Better Auth 1.7.3 stopped writing `issuer`, so the account identity key is
  // (provider_id, account_id): the pair the library links accounts by. The
  // replacement is proven ready before this retires the legacy index, so no
  // window exists where neither enforces uniqueness.
  {
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
  CASE_LAW_PARSED_SOURCE_VALIDATION,
  ...AGENT_SKILL_BINDING_CONSTRAINT_VALIDATIONS,
  CHAT_CONTENT_V3_REPAIR,
  DECISION_DATE_CEILING_REPAIR,
  CORPUS_PROJECTION_DELETE_RECEIPT_REPAIR,
  ...SANCTIONS_MONITORING_CONSTRAINT_VALIDATIONS,
  LIST_VERIFICATION_CONSTRAINT_VALIDATION,
  ORGANIZATION_ACCESS_STATE_CONSTRAINT_VALIDATION,
  ...READER_ANNOTATION_CLAIM_CONSTRAINT_VALIDATIONS,
  ...INVOICE_LANGUAGE_CONSTRAINT_VALIDATIONS,
  USER_LOCALE_CONSTRAINT_VALIDATION,
  CONTACT_VAT_ID_REPAIR,
  ENTITY_FEATURE_GATE_REPAIR,
  CORPUS_PROJECTION_CLEANUP_STALL_REPAIR,
  // Not behind one migration: the OAuth resource set is derived from the MCP
  // audiences in application code, so it is the code that moves and the rows
  // that follow. Its completion is the startup census, so the deploy that
  // widens the audience set is the one that reconciles them, without an
  // operator step.
  BETTER_AUTH_OAUTH_RESOURCE_REPAIR,
];

/**
 * Every constraint a registered repair validates through the table gate. The
 * entity feature gate's checks are validated on each relation of a graph the
 * database holds, so `ENTITY_FEATURE_GATE_CONSTRAINT_NAMES` names those.
 */
export const ONLINE_CONSTRAINT_VALIDATIONS: readonly OnlineConstraintValidation[] =
  [
    CASE_LAW_PARSED_SOURCE_CONSTRAINT,
    ...AGENT_SKILL_BINDING_CONSTRAINTS,
    ...CHAT_CONTENT_V3_CONSTRAINTS,
    ...DECISION_DATE_CEILING_CONSTRAINTS,
    ...CORPUS_PROJECTION_DELETE_RECEIPT_CONSTRAINTS,
    ...SANCTIONS_MONITORING_CONSTRAINTS,
    ...LIST_VERIFICATION_CONSTRAINTS,
    ...ORGANIZATION_ACCESS_STATE_CONSTRAINTS,
    ...READER_ANNOTATION_CLAIM_CONSTRAINTS,
    ...INVOICE_LANGUAGE_CONSTRAINTS,
    USER_LOCALE_CONSTRAINT,
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
  | { operation: "validate" };

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

type OnlineValidationOutcome =
  { type: "validated" } | { type: "migrator_active" };

const VALIDATED = {
  type: "validated",
} as const satisfies OnlineValidationOutcome;
const MIGRATOR_ACTIVE = {
  type: "migrator_active",
} as const satisfies OnlineValidationOutcome;

/**
 * Startup validation. It never waits on the migrator: a migrate run holds the
 * online lock for a whole index build, longer than any statement timeout, so
 * a waiting boot would fail on the timeout instead. While the migrator holds
 * the lock it owns these objects and may be mid-cutover, so startup leaves
 * them to it rather than read a state between two of its statements.
 */
export const assertOnlineMigrationsApplied = async (
  pool: OnlineMigrationPool,
  options: OnlineMigrationOptions = {},
): Promise<OnlineValidationOutcome> => {
  const connection = await pool.reserve();
  try {
    const sessionTimeout = await readStatementTimeout(connection);
    await connection.execute(STARTUP_VALIDATION_TIMEOUT_SQL);
    try {
      if (!(await tryAcquireOnlineMigrationLock(connection))) {
        return MIGRATOR_ACTIVE;
      }
      try {
        const outcome = await walkOnlineMigrations({
          connection,
          mode: { operation: "validate" },
          options,
        });
        if (outcome.type !== "complete") {
          panic("Online migration validation cannot defer");
        }
        return VALIDATED;
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
    await assertIndexReady(connection, index);
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
    await assertIndexReady(connection, cutover.final);
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
  if (mode.operation === "repair" && completion.type !== "complete") {
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
    if (completion.type === "pending") {
      log({ event: "online_repair_pending", repair: repair.name, completion });
    }
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
  index: OnlineIndex;
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
