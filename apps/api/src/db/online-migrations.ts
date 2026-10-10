import { panic, Result } from "better-result";

import {
  DOCUMENT_OUTSTANDING_DATE_INDEX,
  DOCUMENT_OUTSTANDING_INDEX,
} from "@/api/lib/legal-search/sk-document-outstanding-index";

import {
  REWRITTEN_MIGRATION_INDEXES,
  type RequiredMigrationIndex,
} from "../lib/db/migration-history";
import { BackfillHeldError } from "./backfill-runtime";
import { BETTER_AUTH_OAUTH_RESOURCE_REPAIR } from "./better-auth-oauth-resource-repair";
import { CORPUS_PROJECTION_CLEANUP_STALL_REPAIR } from "./corpus-projection-cleanup-stall-repair";
import { CORPUS_PROJECTION_DELETE_RECEIPT_REPAIR } from "./corpus-projection-delete-receipt-repair";
import { DECISION_DATE_CEILING_REPAIR } from "./decision-date-ceiling-repair";
import { ENTITY_FEATURE_GATE_REPAIR } from "./entity-feature-gate-repair";
import { LIST_VERIFICATION_CONSTRAINT_VALIDATION } from "./list-verification-constraint-validation";
import { createOnlineIndexGate } from "./online-index-gate";
import type { OnlineIndexGateOptions } from "./online-index-gate";
import type {
  OnlineMigrationConnection,
  OnlineMigrationPool,
  OnlineRepair,
  OnlineRepairCompletion,
} from "./online-migration-connection";
import { SANCTIONS_MONITORING_CONSTRAINT_VALIDATIONS } from "./sanctions-monitoring-constraint-validation";

// Fast DDL retains a short lock budget; guarded concurrent index work lifts it
// and uses the observer watchdog for virtual transaction waits.
const ONLINE_MIGRATION_LOCK_TIMEOUT_SQL = "SET lock_timeout = '1s'";
const ONLINE_MIGRATIONS_LOCK_SQL =
  "SELECT pg_advisory_lock(hashtext('stella-online-migrations'))";
const ONLINE_MIGRATIONS_UNLOCK_SQL =
  "SELECT pg_advisory_unlock(hashtext('stella-online-migrations'))";
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

type OnlineIndex = RequiredMigrationIndex & {
  createSql?: string;
};

export const ONLINE_MIGRATION_INDEXES: readonly OnlineIndex[] = [
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

const ONLINE_INDEX_REPLACEMENTS: readonly OnlineIndexReplacement[] = [
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
  DECISION_DATE_CEILING_REPAIR,
  CORPUS_PROJECTION_DELETE_RECEIPT_REPAIR,
  ...SANCTIONS_MONITORING_CONSTRAINT_VALIDATIONS,
  LIST_VERIFICATION_CONSTRAINT_VALIDATION,
  ENTITY_FEATURE_GATE_REPAIR,
  CORPUS_PROJECTION_CLEANUP_STALL_REPAIR,
  // Not behind one migration: the OAuth resource set is derived from the MCP
  // audiences in application code, so it is the code that moves and the rows
  // that follow. Its completion is the startup census, so the deploy that
  // widens the audience set is the one that reconciles them, without an
  // operator step.
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
    }
  | { operation: "validate" };

type OnlineMigrationOperation = OnlineMigrationMode["operation"];

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
};

export const runOnlineMigrations = async (
  pool: OnlineMigrationPool,
  { indexGate, reserveObserver, ...options }: OnlineRepairOptions,
): Promise<OnlineMigrationOutcome> =>
  await processOnlineMigrations(
    pool,
    { operation: "repair", indexGate, reserveObserver },
    options,
  );

export const assertOnlineMigrationsApplied = async (
  pool: OnlineMigrationPool,
  options: OnlineMigrationOptions = {},
): Promise<void> => {
  const outcome = await processOnlineMigrations(
    pool,
    { operation: "validate" },
    options,
  );
  if (outcome.type !== "complete") {
    panic("Online migration validation cannot defer");
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
    await connection.execute(ONLINE_MIGRATIONS_LOCK_SQL);
    lockAcquired = true;

    if (mode.operation === "repair") {
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
      await retireReplacedIndexAt(connection);
    }
    await processOnlineRepairAt({
      connection,
      operation: mode.operation,
      repairs: options.repairs ?? ONLINE_MIGRATION_REPAIRS,
      log:
        options.log ??
        ((record) => process.stderr.write(`${JSON.stringify(record)}\n`)),
    });
    return COMPLETE;
  } finally {
    try {
      if (lockAcquired && sessionIsActive()) {
        await connection.execute(ONLINE_MIGRATIONS_UNLOCK_SQL);
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
    const outcome = await ensureOnlineIndexValid({
      connection,
      index,
      gate: mode.indexGate,
      reserveObserver: mode.reserveObserver,
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
    const outcome = await completeIndexCutover({
      connection,
      cutover,
      repair: mode,
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
  operation: OnlineMigrationOperation;
  repairs: readonly OnlineRepair[];
  log: NonNullable<OnlineMigrationOptions["log"]>;
  offset?: number;
};

const processOnlineRepairAt = async ({
  connection,
  operation,
  repairs,
  log,
  offset = 0,
}: OnlineRepairWalkOptions): Promise<void> => {
  const repair = repairs.at(offset);
  if (!repair) {
    return;
  }

  const completion = await repair.readCompletion(connection);
  if (operation === "repair" && completion.type !== "complete") {
    const outcome = await Result.tryPromise({
      try: async () => await repair.repair(connection),
      catch: (cause: unknown) => cause,
    });
    await connection.execute(ONLINE_MIGRATION_LOCK_TIMEOUT_SQL);
    if (
      Result.isError(outcome) &&
      !(outcome.error instanceof BackfillHeldError)
    ) {
      throw outcome.error;
    }
    const settled = await repair.readCompletion(connection);
    if (Result.isError(outcome) && settled.type !== "pending") {
      return panic(
        `Online repair ${repair.name}: hold has no durable pending checkpoint`,
      );
    }
    assertRepairDeployable(repair, settled);
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
  await processOnlineRepairAt({
    connection,
    operation,
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
  offset = 0,
): Promise<void> => {
  const replacement = ONLINE_INDEX_REPLACEMENTS.at(offset);
  if (!replacement) {
    return;
  }

  await assertReplacementIndexAt(connection, replacement);
  await connection.execute(
    `DROP INDEX CONCURRENTLY IF EXISTS public.${quoteIdentifier(replacement.legacyName)}`,
  );
  await retireReplacedIndexAt(connection, offset + 1);
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
        // Waiting here would hold the caller's corpus schema lane for as long
        // as the database stays unhealthy. A build cancelled into INVALID is
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
