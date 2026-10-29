import { panic } from "better-result";
import { getColumns, getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import {
  type IntroducedMigrationIndex,
  REWRITTEN_MIGRATION_INDEXES,
} from "../lib/db/migration-history";
import type { OnlineIndexDeclaration } from "./online-ddl";
import type { OnlineStepIntroduction } from "./online-migration-connection";

export const CONTACTS_ORG_ID_UNIQUE = "contacts_org_id_unique";
export const SESSION_PRIOR_TOKEN_HASH_IDX = "session_priorTokenHash_idx";
export const INVOICES_ID_WORKSPACE_UNIQUE = "invoices_id_workspace_unique";
export const LEGAL_LISTS_SAMPLE_WORKSPACE_UIDX =
  "legal_lists_sample_workspace_uidx";
export const ACCOUNT_PROVIDER_ACCOUNT_ID_UIDX =
  "account_provider_account_id_uidx";
export const WORKSPACES_ID_ORG_UNQ = "workspaces_id_org_unq";
export const ENTITY_VERSIONS_ID_ENTITY_WS_UIDX =
  "entity_versions_id_entity_ws_uidx";
export const ENTITY_VERSIONS_ENTITY_NUMBER_UIDX =
  "entity_versions_entity_number_uidx";
export const CHAT_MESSAGES_ID_THREAD_UIDX = "chat_messages_id_thread_uidx";
export const TIME_ENTRIES_ONE_ACTIVE_TIMER_PER_USER_IDX =
  "time_entries_one_active_timer_per_user_idx";
export const TIME_TIMERS_LEGACY_ENTRY_UIDX = "time_timers_legacy_entry_uidx";
export const PLAYBOOK_DEFINITIONS_ORG_STARTER_ID_UIDX =
  "playbook_definitions_org_starter_id_uidx";
export const TEMPLATES_ORG_PACK_TEMPLATE_UIDX =
  "templates_org_pack_template_uidx";
export const WORKSPACE_VIEWS_CORRESPONDENCE_UIDX =
  "workspace_views_correspondence_uidx";
export const CHAT_TURNS_ORG_RUN_ID_UIDX = "chat_turns_org_run_id_uidx";
export const LEGAL_READER_ANSWER_MESSAGES_ANSWER_SEQUENCE_IDX =
  "legal_reader_answer_messages_answer_sequence_idx";
export const CASE_LAW_INGESTION_FAILURES_SOURCE_RECORD_UIDX =
  "case_law_ingestion_failures_source_record_uidx";
export const CORRESPONDENCE_WS_SOURCE_ENTITY_UIDX =
  "correspondence_ws_source_entity_uidx";
export const CASE_LAW_DECISIONS_SLUG_UIDX = "case_law_decisions_slug_uidx";
export const ACCOUNT_CREDENTIAL_SINGLETON_UIDX =
  "account_credential_singleton_uidx";
export const PROPERTIES_WS_DOCUMENT_TYPE_CLASSIFIER_UNQ =
  "properties_ws_document_type_classifier_unq";
export const USAGE_EVENTS_ORG_IDEMPOTENCY_KEY_UIDX =
  "usage_events_org_idempotency_key_uidx";
export const CASE_LAW_DECISIONS_SOURCE_DOCUMENT_IDX =
  "case_law_decisions_source_document_idx";
export const CASE_LAW_DECISIONS_SOURCE_CASE_LANG_NULL_IDX =
  "case_law_decisions_source_case_lang_null_idx";

export const EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES = {
  CONTACTS_ORG_ID_UNIQUE,
  SESSION_PRIOR_TOKEN_HASH_IDX,
  INVOICES_ID_WORKSPACE_UNIQUE,
  LEGAL_LISTS_SAMPLE_WORKSPACE_UIDX,
  ACCOUNT_PROVIDER_ACCOUNT_ID_UIDX,
  WORKSPACES_ID_ORG_UNQ,
  ENTITY_VERSIONS_ID_ENTITY_WS_UIDX,
  ENTITY_VERSIONS_ENTITY_NUMBER_UIDX,
  CHAT_MESSAGES_ID_THREAD_UIDX,
  TIME_ENTRIES_ONE_ACTIVE_TIMER_PER_USER_IDX,
  TIME_TIMERS_LEGACY_ENTRY_UIDX,
  PLAYBOOK_DEFINITIONS_ORG_STARTER_ID_UIDX,
  TEMPLATES_ORG_PACK_TEMPLATE_UIDX,
  WORKSPACE_VIEWS_CORRESPONDENCE_UIDX,
  CHAT_TURNS_ORG_RUN_ID_UIDX,
  LEGAL_READER_ANSWER_MESSAGES_ANSWER_SEQUENCE_IDX,
  CASE_LAW_INGESTION_FAILURES_SOURCE_RECORD_UIDX,
  CORRESPONDENCE_WS_SOURCE_ENTITY_UIDX,
} as const;

/** The original-invoice tenant reference uses this online-built covering key. */
export const INVOICE_TENANT_UNIQUE_INDEX = {
  introducedBy: { type: "code", owner: "src/db/online-unique-indexes.ts" },
  createSql:
    'CREATE UNIQUE INDEX CONCURRENTLY "invoices_id_org_unique" ON public."invoices" USING btree (id, organization_id)',
  definitionBody: "ON public.invoices USING btree (id, organization_id)",
  isUnique: true,
  name: "invoices_id_org_unique",
  tableName: "invoices",
} as const satisfies OnlineIndexDeclaration & {
  introducedBy: OnlineStepIntroduction;
};

const INVOICES_CLIENT_NUMBER_INDEX = {
  createSql:
    'CREATE UNIQUE INDEX CONCURRENTLY "invoices_client_number_uidx" ON public."invoices" USING btree (organization_id, client_id, invoice_number) WHERE workspace_id IS NULL',
  definitionBody:
    "ON public.invoices USING btree (organization_id, client_id, invoice_number) WHERE (workspace_id IS NULL)",
  introducedBy: { type: "code", owner: "src/db/online-unique-indexes.ts" },
  isUnique: true,
  name: "invoices_client_number_uidx",
  tableName: "invoices",
} as const satisfies OnlineIndexDeclaration & {
  introducedBy: OnlineStepIntroduction;
};

export const CLIENT_INVOICE_UNIQUE_INDEXES = [
  INVOICE_TENANT_UNIQUE_INDEX,
  INVOICES_CLIENT_NUMBER_INDEX,
] as const;

export const LEGISLATION_UNIQUE_INDEXES = [
  {
    introducedBy: "20261019091000_legislation_publisher_identity",
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "legislation_documents_publisher_identity_idx" ON public."legislation_documents" (source_id, eli, language, publisher_expression_id) WHERE identity_mode = \'publisher-expression\'',
    definitionBody:
      "ON public.legislation_documents USING btree (source_id, eli, language, publisher_expression_id) WHERE ((identity_mode)::text = 'publisher-expression'::text)",
    isUnique: true,
    name: "legislation_documents_publisher_identity_idx",
    tableName: "legislation_documents",
  },
  {
    introducedBy: "20261019091000_legislation_publisher_identity",
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "legislation_documents_legacy_version_lang_idx" ON public."legislation_documents" (source_id, eli, version_valid_from, language) WHERE identity_mode = \'legacy-window\' AND version_valid_from IS NOT NULL',
    definitionBody:
      "ON public.legislation_documents USING btree (source_id, eli, version_valid_from, language) WHERE (((identity_mode)::text = 'legacy-window'::text) AND (version_valid_from IS NOT NULL))",
    isUnique: true,
    name: "legislation_documents_legacy_version_lang_idx",
    tableName: "legislation_documents",
  },
  {
    introducedBy: "20261019091000_legislation_publisher_identity",
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "legislation_documents_legacy_current_lang_idx" ON public."legislation_documents" (source_id, eli, language) WHERE identity_mode = \'legacy-window\' AND version_valid_from IS NULL',
    definitionBody:
      "ON public.legislation_documents USING btree (source_id, eli, language) WHERE (((identity_mode)::text = 'legacy-window'::text) AND (version_valid_from IS NULL))",
    isUnique: true,
    name: "legislation_documents_legacy_current_lang_idx",
    tableName: "legislation_documents",
  },
] as const satisfies readonly (OnlineIndexDeclaration & {
  introducedBy: OnlineStepIntroduction;
})[];

export const ONLINE_UNIQUE_INDEX_NAMES = {
  ...EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES,
  LEGISLATION_DOCUMENTS_PUBLISHER_IDENTITY_IDX:
    LEGISLATION_UNIQUE_INDEXES[0].name,
  LEGISLATION_DOCUMENTS_LEGACY_VERSION_LANG_IDX:
    LEGISLATION_UNIQUE_INDEXES[1].name,
  LEGISLATION_DOCUMENTS_LEGACY_CURRENT_LANG_IDX:
    LEGISLATION_UNIQUE_INDEXES[2].name,
  INVOICES_ID_ORG_UNIQUE: INVOICE_TENANT_UNIQUE_INDEX.name,
  INVOICES_CLIENT_NUMBER_UIDX: INVOICES_CLIENT_NUMBER_INDEX.name,
  CASE_LAW_DECISIONS_SLUG_UIDX,
  ACCOUNT_CREDENTIAL_SINGLETON_UIDX,
  PROPERTIES_WS_DOCUMENT_TYPE_CLASSIFIER_UNQ,
  USAGE_EVENTS_ORG_IDEMPOTENCY_KEY_UIDX,
  CASE_LAW_DECISIONS_SOURCE_DOCUMENT_IDX,
  CASE_LAW_DECISIONS_SOURCE_CASE_LANG_NULL_IDX,
} as const;

export type ExecutableOnlineUniqueIndexName =
  (typeof EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES)[keyof typeof EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES];

export type OnlineUniqueIndexName =
  (typeof ONLINE_UNIQUE_INDEX_NAMES)[keyof typeof ONLINE_UNIQUE_INDEX_NAMES];

export type ExecutableOnlineUniqueIndex = OnlineIndexDeclaration &
  IntroducedMigrationIndex;

const EXECUTABLE_ONLINE_UNIQUE_INDEXES = [
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "contacts_org_id_unique" ON public."contacts" USING btree ("organization_id", "id")',
    definitionBody: "ON public.contacts USING btree (organization_id, id)",
    isUnique: true,
    introducedBy: "20261003122700_sanctions_monitoring_contact_index",
    name: CONTACTS_ORG_ID_UNIQUE,
    tableName: "contacts",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "session_priorTokenHash_idx" ON public."session" USING btree ("prior_token_hash")',
    definitionBody: "ON public.session USING btree (prior_token_hash)",
    isUnique: true,
    introducedBy: "20261003123100_session_lifetime",
    name: SESSION_PRIOR_TOKEN_HASH_IDX,
    tableName: "session",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "invoices_id_workspace_unique" ON public."invoices" USING btree ("id", "workspace_id")',
    definitionBody: "ON public.invoices USING btree (id, workspace_id)",
    isUnique: true,
    introducedBy: "20261003122400_invoice_document_types",
    name: INVOICES_ID_WORKSPACE_UNIQUE,
    tableName: "invoices",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "legal_lists_sample_workspace_uidx" ON public."legal_lists" USING btree ("workspace_id") WHERE "sample_case" IS NOT NULL',
    definitionBody:
      "ON public.legal_lists USING btree (workspace_id) WHERE (sample_case IS NOT NULL)",
    isUnique: true,
    introducedBy: "20261014180800_avt_sample_case",
    name: LEGAL_LISTS_SAMPLE_WORKSPACE_UIDX,
    tableName: "legal_lists",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "account_provider_account_id_uidx" ON public."account" USING btree ("provider_id", "account_id")',
    definitionBody: "ON public.account USING btree (provider_id, account_id)",
    isUnique: true,
    introducedBy: "20260916140000_account_issuer_nullable",
    name: ACCOUNT_PROVIDER_ACCOUNT_ID_UIDX,
    tableName: "account",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "workspaces_id_org_unq" ON public."workspaces" USING btree ("id", "organization_id")',
    definitionBody: "ON public.workspaces USING btree (id, organization_id)",
    isUnique: true,
    introducedBy: "20260808007000_ai_memory_workspace_tenant_index",
    name: WORKSPACES_ID_ORG_UNQ,
    tableName: "workspaces",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "entity_versions_id_entity_ws_uidx" ON public."entity_versions" USING btree ("id", "entity_id", "workspace_id")',
    definitionBody:
      "ON public.entity_versions USING btree (id, entity_id, workspace_id)",
    isUnique: true,
    introducedBy: "20260808014000_legal_lists",
    name: ENTITY_VERSIONS_ID_ENTITY_WS_UIDX,
    tableName: "entity_versions",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "entity_versions_entity_number_uidx" ON public."entity_versions" USING btree ("entity_id", "version_number")',
    definitionBody:
      "ON public.entity_versions USING btree (entity_id, version_number)",
    isUnique: true,
    introducedBy: "20260827200000_folio_collab_rooms",
    name: ENTITY_VERSIONS_ENTITY_NUMBER_UIDX,
    tableName: "entity_versions",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "chat_messages_id_thread_uidx" ON public."chat_messages" USING btree ("id", "thread_id")',
    definitionBody: "ON public.chat_messages USING btree (id, thread_id)",
    isUnique: true,
    introducedBy: "20260803100000_chat_turns",
    name: CHAT_MESSAGES_ID_THREAD_UIDX,
    tableName: "chat_messages",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "time_entries_one_active_timer_per_user_idx" ON public."time_entries" USING btree ("user_id") WHERE "timer_started_at" IS NOT NULL',
    definitionBody:
      "ON public.time_entries USING btree (user_id) WHERE (timer_started_at IS NOT NULL)",
    isUnique: true,
    introducedBy: "20260809120002_unique_active_time_entry_timer",
    name: TIME_ENTRIES_ONE_ACTIVE_TIMER_PER_USER_IDX,
    tableName: "time_entries",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "time_timers_legacy_entry_uidx" ON public."time_timers" USING btree ("legacy_time_entry_id") WHERE "legacy_time_entry_id" IS NOT NULL',
    definitionBody:
      "ON public.time_timers USING btree (legacy_time_entry_id) WHERE (legacy_time_entry_id IS NOT NULL)",
    isUnique: true,
    introducedBy: "20261003122600_timer_admin_stop",
    name: TIME_TIMERS_LEGACY_ENTRY_UIDX,
    tableName: "time_timers",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "playbook_definitions_org_starter_id_uidx" ON public."playbook_definitions" USING btree ("organization_id", "starter_id") WHERE "starter_id" IS NOT NULL',
    definitionBody:
      "ON public.playbook_definitions USING btree (organization_id, starter_id) WHERE (starter_id IS NOT NULL)",
    isUnique: true,
    introducedBy: "20260814000000_playbook_starter_idempotency",
    name: PLAYBOOK_DEFINITIONS_ORG_STARTER_ID_UIDX,
    tableName: "playbook_definitions",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "templates_org_pack_template_uidx" ON public."templates" USING btree ("organization_id", (("origin"->>\'packId\')), (("origin"->>\'slug\'))) WHERE "origin_type" = \'bundled-pack\'',
    definitionBody:
      "ON public.templates USING btree (organization_id, ((origin ->> 'packId'::text)), ((origin ->> 'slug'::text))) WHERE (origin_type = 'bundled-pack'::text)",
    isUnique: true,
    introducedBy: "20260819200000_template_origin_and_pack_offers",
    name: TEMPLATES_ORG_PACK_TEMPLATE_UIDX,
    tableName: "templates",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "workspace_views_correspondence_uidx" ON public."workspace_views" USING btree ("workspace_id") WHERE ("layout" ->> \'type\') = \'correspondence\'',
    definitionBody:
      "ON public.workspace_views USING btree (workspace_id) WHERE ((layout ->> 'type'::text) = 'correspondence'::text)",
    isUnique: true,
    introducedBy: "20261003122800_workspace_views_correspondence_uidx",
    name: WORKSPACE_VIEWS_CORRESPONDENCE_UIDX,
    tableName: "workspace_views",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "chat_turns_org_run_id_uidx" ON public."chat_turns" USING btree ("organization_id", "run_id") WHERE "run_id" IS NOT NULL',
    definitionBody:
      "ON public.chat_turns USING btree (organization_id, run_id) WHERE (run_id IS NOT NULL)",
    isUnique: true,
    introducedBy: "20261003121500_chat_turn_run_ownership",
    name: CHAT_TURNS_ORG_RUN_ID_UIDX,
    tableName: "chat_turns",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "legal_reader_answer_messages_answer_sequence_idx" ON public."legal_reader_answer_messages" USING btree ("answer_id", "sequence")',
    definitionBody:
      "ON public.legal_reader_answer_messages USING btree (answer_id, sequence)",
    isUnique: true,
    introducedBy: "20261010212300_reader_answer_message_sequence",
    name: LEGAL_READER_ANSWER_MESSAGES_ANSWER_SEQUENCE_IDX,
    tableName: "legal_reader_answer_messages",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "case_law_ingestion_failures_source_record_uidx" ON public."case_law_ingestion_failures" USING btree ("source_id", "record_identity") WHERE "record_identity" IS NOT NULL',
    definitionBody:
      "ON public.case_law_ingestion_failures USING btree (source_id, record_identity) WHERE (record_identity IS NOT NULL)",
    isUnique: true,
    introducedBy: "20261003122700_case_law_ingestion_failure_record_identity",
    name: CASE_LAW_INGESTION_FAILURES_SOURCE_RECORD_UIDX,
    tableName: "case_law_ingestion_failures",
  },
  {
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY "correspondence_ws_source_entity_uidx" ON public."correspondence" USING btree ("workspace_id", "source_entity_id")',
    definitionBody:
      "ON public.correspondence USING btree (workspace_id, source_entity_id)",
    isUnique: true,
    introducedBy: "20261004120100_uploaded_mail_correspondence",
    name: CORRESPONDENCE_WS_SOURCE_ENTITY_UIDX,
    tableName: "correspondence",
  },
] as const satisfies readonly ExecutableOnlineUniqueIndex[];

export const ONLINE_UNIQUE_INDEX_VALIDATION_DEFINITIONS: readonly (Omit<
  IntroducedMigrationIndex,
  "introducedBy"
> & { introducedBy: OnlineStepIntroduction })[] = [
  ...EXECUTABLE_ONLINE_UNIQUE_INDEXES,
  ...CLIENT_INVOICE_UNIQUE_INDEXES,
  ...LEGISLATION_UNIQUE_INDEXES,
  ...REWRITTEN_MIGRATION_INDEXES.filter(({ isUnique }) => isUnique),
];

// PostgreSQL infers a unique index from its column target and optional predicate.
// Keep conflict targets attached to the same definition used by online validation.
export const onlineUniqueIndexDefinition = (
  name: ExecutableOnlineUniqueIndexName,
): ExecutableOnlineUniqueIndex => {
  const index = EXECUTABLE_ONLINE_UNIQUE_INDEXES.find(
    (candidate) => candidate.name === name,
  );
  if (index === undefined) {
    return panic(`Unknown online unique index: ${name}`);
  }
  return index;
};

// Index expressions can contain nested calls and quoted closing parentheses.
export const onlineIndexColumnTarget = (definition: string) => {
  const marker = " USING btree (";
  const start = definition.indexOf(marker);
  if (start === -1) {
    return panic(`Online unique index has no btree target: ${definition}`);
  }
  const begin = start + marker.length;
  let depth = 1;
  let quote = "";
  for (let position = begin; position < definition.length; position += 1) {
    const char = definition[position];
    if (quote !== "") {
      if (char === quote && definition[position + 1] === quote) {
        position += 1;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return definition.slice(begin, position);
      }
    }
  }
  return panic(`Online unique index target is unbalanced: ${definition}`);
};

// Drizzle accepts columns rather than SQL expressions as conflict targets.
export const onlineUniqueIndexTarget = (
  name: OnlineUniqueIndexName,
  table: PgTable,
) => {
  const index = ONLINE_UNIQUE_INDEX_VALIDATION_DEFINITIONS.find(
    (candidate) => candidate.name === name,
  );
  if (index === undefined) {
    return panic(`Unknown online unique index: ${name}`);
  }
  if (getTableName(table) !== index.tableName) {
    return panic(
      `Online unique index ${name} does not belong to ${getTableName(table)}`,
    );
  }
  const columns = Object.values(getColumns(table));
  return onlineIndexColumnTarget(index.definitionBody)
    .split(",")
    .map((targetName) => {
      const columnName = targetName.trim().replaceAll('"', "");
      const column = columns.find((candidate) => candidate.name === columnName);
      if (column === undefined) {
        return panic(
          `Online unique index target column is absent: ${columnName}`,
        );
      }
      return column;
    });
};
