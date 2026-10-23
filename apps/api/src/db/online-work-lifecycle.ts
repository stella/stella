import type { OnlineWorkName } from "./online-migrations";

export type OnlineWorkLifecycle = { state: "pending" } | { state: "finalized" };

export const PENDING = {
  state: "pending",
} as const satisfies OnlineWorkLifecycle;
export const FINALIZED = {
  state: "finalized",
} as const satisfies OnlineWorkLifecycle;

// Work is finalized only by a later PR, once a stable release tag contains
// the commit that registered it (`scripts/check-online-work-lifecycle.ts`).
// One `name: PENDING` or `name: FINALIZED` line per entry: that check reads
// this file's history line by line.
export const ONLINE_WORK_LIFECYCLE = {
  case_law_citations_doctrine_cited_idx: FINALIZED,
  apikey_personal_owner_keyset_idx: FINALIZED,
  sanctions_contact_matches_org_open_cursor_idx: FINALIZED,
  case_law_decisions_country_date_published_idx: FINALIZED,
  case_law_decisions_citation_candidate_published_idx: FINALIZED,
  case_law_decisions_source_arrivals_published_idx: FINALIZED,
  case_law_decisions_sitemap_shard_published_idx: FINALIZED,
  case_law_decisions_search_candidate_published_idx: FINALIZED,
  sanctions_screening_events_org_cursor_idx: FINALIZED,
  contacts_org_id_unique: FINALIZED,
  rate_entries_table_role_from_idx: FINALIZED,
  session_priorTokenHash_idx: FINALIZED,
  time_entries_org_status_date_id_idx: FINALIZED,
  time_entries_approval_queue_idx: FINALIZED,
  invoices_id_workspace_unique: FINALIZED,
  invoices_ws_original_idx: FINALIZED,
  legal_lists_sample_workspace_uidx: FINALIZED,
  case_law_decisions_provision_scope_cursor_idx: FINALIZED,
  case_law_provision_extractions_jurisdiction_due_idx: FINALIZED,
  case_law_provision_extractions_pending_idx: FINALIZED,
  case_law_provision_extractions_clock_seed_idx: FINALIZED,
  case_law_decisions_docket_family_key_idx: FINALIZED,
  account_provider_account_id_uidx: FINALIZED,
  chat_thread_compactions_memory_unmined_org_idx: FINALIZED,
  organization_settings_memory_extraction_queue_idx: FINALIZED,
  workspaces_id_org_unq: FINALIZED,
  entity_versions_id_entity_ws_uidx: FINALIZED,
  entity_versions_entity_number_uidx: FINALIZED,
  chat_messages_id_thread_uidx: FINALIZED,
  time_entries_one_active_timer_per_user_idx: FINALIZED,
  time_timers_running_org_id_idx: FINALIZED,
  time_timers_legacy_entry_uidx: FINALIZED,
  playbook_definitions_org_starter_id_uidx: FINALIZED,
  templates_org_pack_template_uidx: FINALIZED,
  workspace_views_correspondence_uidx: FINALIZED,
  report_exports_workspace_requester_created_idx: FINALIZED,
  folio_collab_rooms_workspace_source_version_idx: FINALIZED,
  legislation_documents_country_slug_idx: FINALIZED,
  chat_turns_org_run_id_uidx: FINALIZED,
  legal_reader_answer_messages_answer_sequence_idx: FINALIZED,
  case_law_ingestion_failures_source_record_uidx: FINALIZED,
  correspondence_ws_source_entity_uidx: FINALIZED,
  correspondence_attachments_ws_entity_idx: FINALIZED,
  sanctions_contact_marks_retry_idx: FINALIZED,
  sanctions_contact_marks_organization_retry_idx: FINALIZED,
  case_law_decisions_source_decision_date_coverage_idx: FINALIZED,
  session_monitoring_id_idx: FINALIZED,
  folio_collab_room_tokens_source_session_idx: FINALIZED,
  case_law_decisions_document_outstanding_idx: FINALIZED,
  case_law_decisions_document_outstanding_date_idx: FINALIZED,
  chat_messages_content_v3_pending_idx: FINALIZED,
  chat_message_revisions_content_v3_pending_idx: FINALIZED,
  case_law_decisions_slug_uidx: FINALIZED,
  fields_pending_workspace_idx: FINALIZED,
  contacts_display_name_arabic_norm_trgm_idx: FINALIZED,
  contacts_first_name_arabic_norm_trgm_idx: FINALIZED,
  contacts_last_name_arabic_norm_trgm_idx: FINALIZED,
  contacts_organization_name_arabic_norm_trgm_idx: FINALIZED,
  properties_workspace_playbook_definition_idx: FINALIZED,
  account_credential_singleton_uidx: FINALIZED,
  properties_ws_document_type_classifier_unq: FINALIZED,
  usage_events_org_idempotency_key_uidx: FINALIZED,
  report_exports_pending_notification_idx: FINALIZED,
  user_createdAt_idx: FINALIZED,
  apikey_metadata_organization_id_idx: FINALIZED,
  apikey_org_keyset_idx: FINALIZED,
  case_law_decisions_source_document_idx: FINALIZED,
  case_law_decisions_source_case_lang_null_idx: FINALIZED,
  case_law_citations_polarity_rule_idx: FINALIZED,
  case_law_decisions_updated_id_idx: FINALIZED,
  case_law_decisions_country_date_idx: FINALIZED,
  case_law_decisions_source_arrivals_idx: FINALIZED,
  case_law_decisions_sitemap_shard_idx: FINALIZED,
  case_law_decisions_search_candidate_idx: FINALIZED,
  legal_reader_answer_messages_answer_idx: FINALIZED,
  case_law_decisions_document_pending_date_idx: FINALIZED,
  case_law_decisions_source_case_lang_idx: FINALIZED,
  account_issuer_account_id_uidx: FINALIZED,
  "decision-date-ceiling": FINALIZED,
  "corpus-projection-delete-receipt": FINALIZED,
  legal_list_verification_runs_error_code_check: FINALIZED,
  "entity-feature-row-gates": FINALIZED,
  "corpus-projection-cleanup-stall": FINALIZED,
  "better-auth-oauth-resources": FINALIZED,
  sanctions_contact_marks_attempt_count_check: FINALIZED,
  contacts_sanctions_monitoring_mode_check: FINALIZED,
  organization_settings_sanctions_monitoring_mode_check: FINALIZED,
  sanctions_contact_matches_disposition_check: FINALIZED,
  sanctions_screening_events_type_check: FINALIZED,
  sanctions_contact_screenings_status_check: FINALIZED,
  sanctions_contact_screenings_incomplete_edition_check: FINALIZED,
  "chat-content-v3": FINALIZED,
  case_law_decisions_republished_ruling_idx: FINALIZED,
} as const satisfies Record<OnlineWorkName, OnlineWorkLifecycle>;

declare const finalizedWorkBrand: unique symbol;

export type FinalizedWorkName = {
  [
    Name in keyof typeof ONLINE_WORK_LIFECYCLE
  ]: (typeof ONLINE_WORK_LIFECYCLE)[Name]["state"] extends "finalized"
    ? Name
    : never;
}[keyof typeof ONLINE_WORK_LIFECYCLE];

export type FinalizedWork<N extends FinalizedWorkName> = N & {
  readonly [finalizedWorkBrand]?: never;
};

export const finalizedWork = <N extends FinalizedWorkName>(
  name: N,
): FinalizedWork<N> => name;
