import { panic, Result } from "better-result";

import { CASE_LAW_COVERAGE_INDEX } from "@/api/lib/case-law/coverage-index";
import {
  DOCUMENT_OUTSTANDING_DATE_INDEX,
  DOCUMENT_OUTSTANDING_INDEX,
} from "@/api/lib/legal-search/sk-document-outstanding-index";

import {
  REWRITTEN_MIGRATION_INDEXES,
  type IntroducedMigrationIndex,
  type RequiredMigrationIndex,
} from "../lib/db/migration-history";
import { BackfillHeldError } from "./backfill-runtime";
import { BETTER_AUTH_OAUTH_RESOURCE_REPAIR } from "./better-auth-oauth-resource-repair";
import {
  CHAT_CONTENT_V3_REPAIR,
  CHAT_CONTENT_V3_SOURCES,
} from "./chat-content-v3-backfill";
import { CORPUS_PROJECTION_CLEANUP_STALL_REPAIR } from "./corpus-projection-cleanup-stall-repair";
import { CORPUS_PROJECTION_DELETE_RECEIPT_REPAIR } from "./corpus-projection-delete-receipt-repair";
import { DECISION_DATE_CEILING_REPAIR } from "./decision-date-ceiling-repair";
import { ENTITY_FEATURE_GATE_REPAIR } from "./entity-feature-gate-repair";
import { LIST_VERIFICATION_CONSTRAINT_VALIDATION } from "./list-verification-constraint-validation";
import { DEFAULT_MIGRATION_TIMING, timed } from "./migration-timing";
import type { MigrationTiming } from "./migration-timing";
import { createOnlineIndexGate } from "./online-index-gate";
import type { OnlineIndexGateOptions } from "./online-index-gate";
import type {
  OnlineMigrationConnection,
  OnlineMigrationPool,
  OnlineRepair,
  OnlineRepairCompletion,
} from "./online-migration-connection";
import {
  onlineUniqueIndexDefinition,
  ONLINE_UNIQUE_INDEX_NAMES,
} from "./online-unique-indexes";
import { SANCTIONS_MONITORING_CONSTRAINT_VALIDATIONS } from "./sanctions-monitoring-constraint-validation";

// Fast DDL retains a short lock budget; guarded concurrent index work lifts it
// and uses the observer watchdog for virtual transaction waits.
const ONLINE_MIGRATION_LOCK_TIMEOUT_SQL = "SET lock_timeout = '1s'";
const ONLINE_MIGRATIONS_LOCK_SQL =
  "SELECT pg_advisory_lock(hashtext('stella-online-migrations'))";
const ONLINE_MIGRATIONS_UNLOCK_SQL =
  "SELECT pg_advisory_unlock(hashtext('stella-online-migrations'))";

export const acquireOnlineMigrationLock = async (
  connection: OnlineMigrationConnection,
): Promise<void> => {
  await connection.execute(ONLINE_MIGRATIONS_LOCK_SQL);
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

type OnlineIndex = IntroducedMigrationIndex & {
  createSql?: string;
};

export const ONLINE_MIGRATION_INDEXES: readonly OnlineIndex[] = [
  ...Object.values(CHAT_CONTENT_V3_SOURCES).map(({ table: tableName }) => ({
    createSql: `CREATE INDEX CONCURRENTLY "${tableName}_content_v3_pending_idx" ON public."${tableName}" (id) WHERE (content -> 'version') IS DISTINCT FROM '3'::jsonb`,
    definitionBody: `ON public.${tableName} USING btree (id) WHERE ((content -> 'version'::text) IS DISTINCT FROM '3'::jsonb)`,
    introducedBy: CHAT_CONTENT_V3_REPAIR.introducedBy,
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
    introducedBy: "20261014174500_case_law_citation_doctrine",
    isUnique: false,
    name: "case_law_citations_doctrine_cited_idx",
    tableName: "case_law_citations",
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
  onlineUniqueIndexDefinition(ONLINE_UNIQUE_INDEX_NAMES.CONTACTS_ORG_ID_UNIQUE),
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
    ONLINE_UNIQUE_INDEX_NAMES.SESSION_PRIOR_TOKEN_HASH_IDX,
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
  onlineUniqueIndexDefinition(
    ONLINE_UNIQUE_INDEX_NAMES.INVOICES_ID_WORKSPACE_UNIQUE,
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
    ONLINE_UNIQUE_INDEX_NAMES.LEGAL_LISTS_SAMPLE_WORKSPACE_UIDX,
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
    ONLINE_UNIQUE_INDEX_NAMES.ACCOUNT_PROVIDER_ACCOUNT_ID_UIDX,
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
  onlineUniqueIndexDefinition(ONLINE_UNIQUE_INDEX_NAMES.WORKSPACES_ID_ORG_UNQ),
  onlineUniqueIndexDefinition(
    ONLINE_UNIQUE_INDEX_NAMES.ENTITY_VERSIONS_ID_ENTITY_WS_UIDX,
  ),
  onlineUniqueIndexDefinition(
    ONLINE_UNIQUE_INDEX_NAMES.ENTITY_VERSIONS_ENTITY_NUMBER_UIDX,
  ),
  onlineUniqueIndexDefinition(
    ONLINE_UNIQUE_INDEX_NAMES.CHAT_MESSAGES_ID_THREAD_UIDX,
  ),
  onlineUniqueIndexDefinition(
    ONLINE_UNIQUE_INDEX_NAMES.TIME_ENTRIES_ONE_ACTIVE_TIMER_PER_USER_IDX,
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
    ONLINE_UNIQUE_INDEX_NAMES.TIME_TIMERS_LEGACY_ENTRY_UIDX,
  ),
  onlineUniqueIndexDefinition(
    ONLINE_UNIQUE_INDEX_NAMES.PLAYBOOK_DEFINITIONS_ORG_STARTER_ID_UIDX,
  ),
  onlineUniqueIndexDefinition(
    ONLINE_UNIQUE_INDEX_NAMES.TEMPLATES_ORG_PACK_TEMPLATE_UIDX,
  ),
  onlineUniqueIndexDefinition(
    ONLINE_UNIQUE_INDEX_NAMES.WORKSPACE_VIEWS_CORRESPONDENCE_UIDX,
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
    ONLINE_UNIQUE_INDEX_NAMES.CHAT_TURNS_ORG_RUN_ID_UIDX,
  ),
  onlineUniqueIndexDefinition(
    ONLINE_UNIQUE_INDEX_NAMES.LEGAL_READER_ANSWER_MESSAGES_ANSWER_SEQUENCE_IDX,
  ),
  onlineUniqueIndexDefinition(
    ONLINE_UNIQUE_INDEX_NAMES.CASE_LAW_INGESTION_FAILURES_SOURCE_RECORD_UIDX,
  ),
  onlineUniqueIndexDefinition(
    ONLINE_UNIQUE_INDEX_NAMES.CORRESPONDENCE_WS_SOURCE_ENTITY_UIDX,
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
  ...REWRITTEN_MIGRATION_INDEXES,
];

type OnlineIndexCutover = {
  introducedBy: string;
  final: IntroducedMigrationIndex;
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
  introducedBy: string;
  legacyName: string;
  replacementNames: readonly string[];
};

export const ONLINE_INDEX_REPLACEMENTS: readonly OnlineIndexReplacement[] = [
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
  CHAT_CONTENT_V3_REPAIR,
  DECISION_DATE_CEILING_REPAIR,
  CORPUS_PROJECTION_DELETE_RECEIPT_REPAIR,
  ...SANCTIONS_MONITORING_CONSTRAINT_VALIDATIONS,
  LIST_VERIFICATION_CONSTRAINT_VALIDATION,
  ENTITY_FEATURE_GATE_REPAIR,
  CORPUS_PROJECTION_CLEANUP_STALL_REPAIR,
  BETTER_AUTH_OAUTH_RESOURCE_REPAIR,
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

/**
 * Where the online phase stopped. An index build the database is not healthy
 * enough to start, or that was cancelled for health, defers the phase at that
 * index: every later step may depend on it, so none of them runs, and the
 * caller runs the phase again after `retryAfterMs`.
 */
export type OnlineMigrationOutcome =
  | { type: "complete" }
  | { type: "deferred"; index: string; retryAfterMs: number };

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

export type PendingOnlineMigrationStep = {
  kind: "index" | "cutover" | "replacement_drop" | "repair";
  name: string;
  introducedBy: string;
};

export type OnlineMigrationStartupReport = {
  newestAppliedMigration: string;
  pending: PendingOnlineMigrationStep[];
};

export const reportOnlineMigrations = async (
  pool: OnlineMigrationPool,
  options: OnlineMigrationOptions = {},
): Promise<OnlineMigrationStartupReport> => {
  const ledgerConnection = await pool.reserve();
  let newestAppliedMigration: string;
  try {
    const row = (
      await ledgerConnection.query(
        "SELECT name FROM drizzle.__drizzle_migrations WHERE name IS NOT NULL ORDER BY name DESC LIMIT 1",
      )
    ).at(0);
    if (
      typeof row !== "object" ||
      row === null ||
      !("name" in row) ||
      typeof row.name !== "string"
    ) {
      panic("Online migration startup requires a named applied migration");
    }
    newestAppliedMigration = row.name;
  } finally {
    await ledgerConnection.release();
  }
  const report: OnlineMigrationStartupReport = {
    newestAppliedMigration,
    pending: [],
  };
  const outcome = await processOnlineMigrations(
    pool,
    { operation: "validate", report },
    options,
  );
  if (outcome.type !== "complete") {
    panic("Online migration validation cannot defer");
  }
  return report;
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
  mode: OnlineMigrationMode,
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
    if (mode.operation === "repair") {
      await acquireOnlineMigrationLock(connection);
      lockAcquired = true;
      await connection.execute(ONLINE_MIGRATION_LOCK_TIMEOUT_SQL);
      await connection.execute("SET statement_timeout = '0'");
    }

    const indexes = await processOnlineIndexAt({
      connection,
      mode,
    });
    if (indexes.type === "deferred") {
      return indexes;
    }
    const cutovers = await processOnlineIndexCutoverAt({
      connection,
      mode,
    });
    if (cutovers.type === "deferred") {
      return cutovers;
    }
    if (mode.operation === "repair") {
      await retireReplacedIndexAt(connection, mode.timing);
    } else {
      await reportOnlineReplacements({ connection, report: mode.report });
    }
    await processOnlineRepairAt({
      connection,
      mode,
      repairs: options.repairs ?? ONLINE_MIGRATION_REPAIRS,
      log:
        options.log ??
        ((record) => process.stderr.write(`${JSON.stringify(record)}\n`)),
    });
    return COMPLETE;
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
        await completeIndexCutover({ connection, cutover, repair: mode }),
      describe: ({ type }) => ({ ...step, outcome: type }),
      failure: { ...step, outcome: "failed" },
    });
    if (outcome.type === "deferred") {
      return outcome;
    }
  } else {
    await reportIndexReadiness({
      connection,
      index: { ...cutover.final, introducedBy: cutover.introducedBy },
      report: mode.report,
      kind: "cutover",
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
}: OnlineRepairWalkOptions): Promise<void> => {
  const repair = repairs.at(offset);
  if (!repair) {
    return;
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
    await processOnlineRepairAt({
      connection,
      mode,
      repairs,
      log,
      offset: offset + 1,
    });
    return;
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
      work: async () => {
        const attempt = await Result.tryPromise({
          try: async () => await repair.repair(connection),
          catch: (cause: unknown) => cause,
        });
        await connection.execute(ONLINE_MIGRATION_LOCK_TIMEOUT_SQL);
        if (
          Result.isError(attempt) &&
          !(attempt.error instanceof BackfillHeldError)
        ) {
          throw attempt.error;
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
        outcome: type === "complete" ? "complete" : "pending",
      }),
      failure: { ...step, outcome: "failed" },
    });
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
  await processOnlineRepairAt({
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
  timing: MigrationTiming,
  offset = 0,
): Promise<void> => {
  const replacement = ONLINE_INDEX_REPLACEMENTS.at(offset);
  if (!replacement) {
    return;
  }

  const step = {
    event: "migrate.online_step_duration",
    kind: "replacement_drop",
    name: replacement.legacyName,
  } as const;
  await timed({
    timing,
    work: async () => {
      await assertReplacementIndexAt(connection, replacement);
      await connection.execute(
        `DROP INDEX CONCURRENTLY IF EXISTS public.${quoteIdentifier(replacement.legacyName)}`,
      );
    },
    describe: () => ({ ...step, outcome: "complete" }),
    failure: { ...step, outcome: "failed" },
  });
  await retireReplacedIndexAt(connection, timing, offset + 1);
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
      `Required migration index ${legacy.name} introduced by ${replacement.introducedBy} has a valid reindex artifact`,
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
  connection: OnlineMigrationConnection,
  { name, tableName }: RequiredMigrationIndex,
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
  connection: OnlineMigrationConnection,
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

const cleanupFailedReindexArtifacts = async (
  connection: OnlineMigrationConnection,
  index: RequiredMigrationIndex,
): Promise<void> => {
  const artifacts = await readReindexArtifacts(connection, index);
  await cleanupReindexArtifactAt(connection, index, artifacts);
};

const cleanupReindexArtifactAt = async (
  connection: OnlineMigrationConnection,
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
  await connection.execute(
    `DROP INDEX CONCURRENTLY public.${quoteIdentifier(artifact.name)}`,
  );
  await cleanupReindexArtifactAt(connection, index, artifacts, offset + 1);
};

type ReportIndexReadinessOptions = {
  connection: OnlineMigrationConnection;
  index: RequiredMigrationIndex & { introducedBy: string };
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
        `Required migration index ${index.name} introduced by ${index.introducedBy} has a valid reindex artifact`,
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
  } else if (!index.createSql) {
    panic(`Required migration index ${index.name} is missing`);
  }
  const observer = await reserveObserver();
  try {
    const runtime = createOnlineIndexGate({
      ...gate,
      connection,
      observer,
      tableName: index.tableName,
      name: index.name,
      kind: initialState.type === "present" ? "index_repair" : "index_build",
    });
    try {
      const outcome = await runtime.attempt(async (guardedConnection) => {
        await cleanupFailedReindexArtifacts(guardedConnection, index);
        const state = await readIndexState(guardedConnection, index);
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
          await guardedConnection.execute(
            `REINDEX INDEX CONCURRENTLY public.${quoteIdentifier(index.name)}`,
          );
          return;
        }
        await guardedConnection.execute(
          index.createSql ??
            `CREATE ${index.isUnique ? "UNIQUE " : ""}INDEX CONCURRENTLY ${quoteIdentifier(index.name)} ${index.definitionBody}`,
        );
      });
      switch (outcome) {
        case "done":
          await assertIndexReady(connection, index);
          return COMPLETE;
        // Waiting here would hold the migrate run for as long as the database
        // stays unhealthy; the next run re-reads the ledger first. A build cancelled into INVALID is
        // repaired, with repair priority, by the next run.
        case "retry":
        case "wait":
          return {
            type: "deferred",
            index: index.name,
            retryAfterMs: runtime.retryAfterMs,
          };
        default:
          outcome satisfies never;
          return panic(`Online index ${index.name}: unexpected gate outcome`);
      }
    } finally {
      await runtime.close();
    }
  } finally {
    await observer.release();
  }
};

type CompleteIndexCutoverOptions = {
  connection: OnlineMigrationConnection;
  cutover: OnlineIndexCutover;
  repair: Extract<OnlineMigrationMode, { operation: "repair" }>;
};

const completeIndexCutover = async ({
  connection,
  cutover: { final, staged },
  repair: { indexGate, reserveObserver },
}: CompleteIndexCutoverOptions): Promise<OnlineMigrationOutcome> => {
  const finalState = await readIndexState(connection, final);

  if (finalState.type === "present") {
    const finalIsReady =
      hasExpectedIndexDefinition(final, finalState) &&
      finalState.isValid &&
      finalState.isReady;

    if (finalIsReady) {
      await cleanupFailedReindexArtifacts(connection, final);
      await assertIndexReady(connection, final);
      const stagedState = await readIndexState(connection, staged);
      if (stagedState.type === "present") {
        assertIndexDefinition(staged, stagedState);
        await connection.execute(
          `DROP INDEX CONCURRENTLY public.${quoteIdentifier(staged.name)}`,
        );
      }
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

  if (finalState.type === "present") {
    await connection.execute(
      `DROP INDEX CONCURRENTLY public.${quoteIdentifier(final.name)}`,
    );
  }
  await connection.execute(
    `ALTER INDEX public.${quoteIdentifier(staged.name)} RENAME TO ${quoteIdentifier(final.name)}`,
  );
  await assertIndexReady(connection, final);
  return COMPLETE;
};

const POSTGRES_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const quoteIdentifier = (identifier: string): string => {
  if (!POSTGRES_IDENTIFIER.test(identifier)) {
    panic(`Invalid internal PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
};
