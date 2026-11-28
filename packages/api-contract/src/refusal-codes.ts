import type { ChatTransportErrorCode } from "@stll/anonymize-chat";

import type { ActionAdmissionCode } from "./action-admission";
import type {
  SKILL_EXPORT_TOO_LARGE_CODE,
  SKILL_FROM_CHAT_REFUSAL_CODE,
  SKILL_PACKAGE_REFUSAL_CODE,
  SKILL_PACKAGE_SKILL_NOT_FOUND_CODE,
  SKILL_RESOURCE_REFUSAL_CODE,
  SKILL_SOURCE_UNREACHABLE_CODE,
} from "./agent-skills";
import type { AIFailureCode } from "./ai-errors";
import type { InvoiceIssueBlocker } from "./billing";
import type { MEMBER_BILLING_ACCESS_REFUSAL_CODE } from "./billing-money";
import type { BrowserControlErrorCode } from "./browser-control";
import type { BROWSER_DOWNLOAD_REFUSAL_CODE } from "./browser-downloads";
import type { BROWSER_SITE_GRANT_REFUSAL_CODE } from "./browser-site-grants";
import type { BrowserSiteNoteRefusalCode } from "./browser-site-notes";
import type { CAPABILITY_REQUEST_ERROR_CODE } from "./capability-request";
import type {
  CaseLawAnalysisFailureCode,
  CaseLawAnalysisUnavailableCode,
} from "./case-law-analysis";
import type { CHAT_COMMAND_ERROR_CODE } from "./chat-command";
import type { CONNECT_CONNECTOR_NOT_CONNECTED_CODE } from "./chat-connector";
import type { ChatLocalFilesUndoRefusal } from "./chat-local-files-undo";
import type {
  CHAT_LOCAL_RUN_STEP_CONTENT_CONFLICT_CODE,
  CHAT_LOCAL_RUN_STEP_CONTENT_INVALID_CODE,
  ChatLocalRunAwaitedStepRefusal,
} from "./chat-local-run-step-content";
import type {
  CHAT_QUEUE_SEND_REFUSAL,
  ChatQueueErrorCode,
  ChatSendQueuesInsteadCode,
} from "./chat-queue";
import type {
  CHAT_LOCAL_RUN_ANONYMIZED_REFUSAL_CODE,
  ChatLocalRunRefusal,
  ChatLocalRunSteerRefusal,
} from "./chat-run-target";
import type { CHAT_THREAD_SCOPE_MISMATCH_CODE } from "./chat-thread-scope";
import type { ChatTurnFailureCode } from "./chat-turn-errors";
import type { CONFLICT_CHECK_REFUSAL_CODE } from "./conflict-checks";
import type { CORRESPONDENCE_SOURCE_CHANGED_CODE } from "./correspondence";
import type { ORGANIZATION_DATA_BOX_REFUSAL_CODE } from "./data-box";
import type { DESKTOP_BILLING_DRAFT_REFUSAL_CODE } from "./desktop-billing-drafts";
import type { DesktopRunnerFolderRestoreRefusal } from "./desktop-runner";
import type { DESKTOP_DAY_ENTRIES_TOO_MANY_CODE } from "./desktop-time-entries";
import type { MATTER_REFERENCE_RETIRED_CODE } from "./document-reference";
import type { DocumentTranslationRunErrorCode } from "./document-translation";
import type {
  API_FILE_SECURITY_REJECTED_ERROR_CODE,
  API_VALIDATION_ERROR_CODE,
  API_VERSION_CONFLICT_ERROR_CODE,
  CHAT_CONTINUATION_REJECTED_ERROR_CODE,
  CHAT_HISTORY_CHANGED_ERROR_CODE,
  CHAT_MESSAGE_EMPTY_ERROR_CODE,
  CHAT_THREAD_NOT_FOUND_ERROR_CODE,
  CHAT_TURN_NOT_OWNED_ERROR_CODE,
  ChatInputRefusalCode,
  ChatMessageEditErrorCode,
  CLAUSE_DIRECTIVES_INVALID_CODE,
  CLAUSE_VERSION_LIMIT_ERROR_CODE,
  DOCUMENT_TOO_LARGE_ERROR_CODE,
  DOCX_SUGGESTIONS_PENDING_LIMIT_ERROR_CODE,
  ENCRYPTED_CONTENT_ERROR_CODE,
  IDEMPOTENCY_IN_PROGRESS_CODE,
  IDEMPOTENCY_KEY_REUSED_CODE,
  MEMBER_REMOVAL_BUSY_CODE,
  PREVIEW_UNAVAILABLE_ERROR_CODE,
  SAVED_SEARCH_NOT_FOUND_ERROR_CODE,
} from "./error";
import type { FOLIO_COLLAB_SEED_PREPARING_CODE } from "./folio-collab";
import type { HOSTED_CHECKOUT_REFUSAL_CODE } from "./hosted-checkout";
import type {
  LEGAL_HOLD_ACTIVE,
  LEGAL_HOLD_ERROR_CODE,
  LEGAL_HOLD_REASON_ISSUE_CODE,
} from "./legal-holds";
import type { MatterDocumentAnnotationRefusal } from "./legal-reader-annotations";
import type { LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_CODE } from "./legislation-expression";
import type {
  MATTER_STEWARD_HANDOVER_REQUIRED_CODE,
  MATTER_VISIBILITY_WIDENING_UNCONFIRMED_CODE,
} from "./matter-visibility";
import type { ModelRunCapCode } from "./model-run-caps";
import type { OAuthCallbackErrorCode } from "./oauth-callback-error";
import type { ORGANIZATION_EVALUATION_LIMIT_REACHED_CODE } from "./organization-create";
import type { OUTBOUND_ACTION_REFUSAL_CODE } from "./outbound-action";
import type { PROFESSIONAL_USE_REQUIRED_CODE } from "./professional-use";
import type {
  AI_MONEY_COLUMN_UNAVAILABLE_CODE,
  CELL_OVERRIDE_ABSENT_CODE,
  FILE_PROPERTY_TYPE_IMMUTABLE_CODE,
} from "./property-policy";
import type { ProviderSetupErrorCode } from "./provider-setup";
import type { PUBLIC_COUNTRY_UNAVAILABLE_CODE } from "./public-country-capability";
import type {
  READER_ANSWER_ANCHOR_MISMATCH_CODE,
  ReaderAnswerErrorCode,
} from "./reader-answers";
import type { RecordingTranscriptionRunErrorCode } from "./recording-transcription";
import type { SharepointRefusalCode } from "./sharepoint";
import type { SSO_SIGN_IN_REQUIRED_CODE, SsoCallbackErrorCode } from "./sso";
import type { STATUTE_LIST_SORT_NEEDS_YEAR_CODE } from "./statute-list-sort";
import type {
  TIME_ENTRY_RATE_REQUIRED_CODE,
  TimeApprovalRefusal,
  TimeReturnRefusal,
  TimeSubmitRefusal,
} from "./time-entries";
import type { TIME_ENTRY_REPORT_TOO_LARGE_CODE } from "./time-entry-report";
import type { VerificationScopeRefusal } from "./verification-scope";
import type { MATTER_CONTACT_CAPACITY_CODE } from "./workspace-contacts";

type ValueOf<T extends Record<string, string>> = T[keyof T];
type AssertStringUnion<T extends string> = T;

/**
 * Domain refusal and error codes already defined in `@stll/api-contract`
 * submodules and `@stll/anonymize-chat`.
 */
export type DomainApiRefusalCode =
  | ActionAdmissionCode
  | AIFailureCode
  | BrowserControlErrorCode
  | BrowserSiteNoteRefusalCode
  | CaseLawAnalysisFailureCode
  | CaseLawAnalysisUnavailableCode
  | ChatInputRefusalCode
  | ChatLocalFilesUndoRefusal
  | ChatLocalRunAwaitedStepRefusal
  | ChatLocalRunRefusal
  | ChatLocalRunSteerRefusal
  | ChatMessageEditErrorCode
  | ChatQueueErrorCode
  | ChatSendQueuesInsteadCode
  | ChatTransportErrorCode
  | ChatTurnFailureCode
  | DesktopRunnerFolderRestoreRefusal
  | DocumentTranslationRunErrorCode
  | InvoiceIssueBlocker
  | MatterDocumentAnnotationRefusal
  | ModelRunCapCode
  | OAuthCallbackErrorCode
  | ProviderSetupErrorCode
  | ReaderAnswerErrorCode
  | RecordingTranscriptionRunErrorCode
  | SharepointRefusalCode
  | SsoCallbackErrorCode
  | TimeApprovalRefusal
  | TimeReturnRefusal
  | TimeSubmitRefusal
  | VerificationScopeRefusal
  | ValueOf<typeof BROWSER_DOWNLOAD_REFUSAL_CODE>
  | ValueOf<typeof BROWSER_SITE_GRANT_REFUSAL_CODE>
  | ValueOf<typeof CHAT_COMMAND_ERROR_CODE>
  | ValueOf<typeof CHAT_QUEUE_SEND_REFUSAL>
  | ValueOf<typeof CONFLICT_CHECK_REFUSAL_CODE>
  | ValueOf<typeof DESKTOP_BILLING_DRAFT_REFUSAL_CODE>
  | ValueOf<typeof HOSTED_CHECKOUT_REFUSAL_CODE>
  | ValueOf<typeof LEGAL_HOLD_ERROR_CODE>
  | ValueOf<typeof MATTER_CONTACT_CAPACITY_CODE>
  | ValueOf<typeof MEMBER_BILLING_ACCESS_REFUSAL_CODE>
  | ValueOf<typeof ORGANIZATION_DATA_BOX_REFUSAL_CODE>
  | ValueOf<typeof OUTBOUND_ACTION_REFUSAL_CODE>
  | ValueOf<typeof SKILL_FROM_CHAT_REFUSAL_CODE>
  | ValueOf<typeof SKILL_PACKAGE_REFUSAL_CODE>
  | ValueOf<typeof SKILL_RESOURCE_REFUSAL_CODE>
  | typeof AI_MONEY_COLUMN_UNAVAILABLE_CODE
  | typeof API_FILE_SECURITY_REJECTED_ERROR_CODE
  | typeof API_VALIDATION_ERROR_CODE
  | typeof API_VERSION_CONFLICT_ERROR_CODE
  | typeof CAPABILITY_REQUEST_ERROR_CODE
  | typeof CELL_OVERRIDE_ABSENT_CODE
  | typeof CHAT_CONTINUATION_REJECTED_ERROR_CODE
  | typeof CHAT_HISTORY_CHANGED_ERROR_CODE
  | typeof CHAT_LOCAL_RUN_ANONYMIZED_REFUSAL_CODE
  | typeof CHAT_LOCAL_RUN_STEP_CONTENT_CONFLICT_CODE
  | typeof CHAT_LOCAL_RUN_STEP_CONTENT_INVALID_CODE
  | typeof CHAT_MESSAGE_EMPTY_ERROR_CODE
  | typeof CHAT_THREAD_NOT_FOUND_ERROR_CODE
  | typeof CHAT_THREAD_SCOPE_MISMATCH_CODE
  | typeof CHAT_TURN_NOT_OWNED_ERROR_CODE
  | typeof CLAUSE_DIRECTIVES_INVALID_CODE
  | typeof CLAUSE_VERSION_LIMIT_ERROR_CODE
  | typeof CONNECT_CONNECTOR_NOT_CONNECTED_CODE
  | typeof CORRESPONDENCE_SOURCE_CHANGED_CODE
  | typeof DESKTOP_DAY_ENTRIES_TOO_MANY_CODE
  | typeof DOCUMENT_TOO_LARGE_ERROR_CODE
  | typeof DOCX_SUGGESTIONS_PENDING_LIMIT_ERROR_CODE
  | typeof ENCRYPTED_CONTENT_ERROR_CODE
  | typeof FILE_PROPERTY_TYPE_IMMUTABLE_CODE
  | typeof FOLIO_COLLAB_SEED_PREPARING_CODE
  | typeof IDEMPOTENCY_IN_PROGRESS_CODE
  | typeof IDEMPOTENCY_KEY_REUSED_CODE
  | typeof LEGAL_HOLD_ACTIVE
  | typeof LEGAL_HOLD_REASON_ISSUE_CODE
  | typeof LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_CODE
  | typeof MATTER_REFERENCE_RETIRED_CODE
  | typeof MATTER_STEWARD_HANDOVER_REQUIRED_CODE
  | typeof MATTER_VISIBILITY_WIDENING_UNCONFIRMED_CODE
  | typeof MEMBER_REMOVAL_BUSY_CODE
  | typeof ORGANIZATION_EVALUATION_LIMIT_REACHED_CODE
  | typeof PREVIEW_UNAVAILABLE_ERROR_CODE
  | typeof PROFESSIONAL_USE_REQUIRED_CODE
  | typeof PUBLIC_COUNTRY_UNAVAILABLE_CODE
  | typeof READER_ANSWER_ANCHOR_MISMATCH_CODE
  | typeof SAVED_SEARCH_NOT_FOUND_ERROR_CODE
  | typeof SKILL_EXPORT_TOO_LARGE_CODE
  | typeof SKILL_PACKAGE_SKILL_NOT_FOUND_CODE
  | typeof SKILL_SOURCE_UNREACHABLE_CODE
  | typeof SSO_SIGN_IN_REQUIRED_CODE
  | typeof STATUTE_LIST_SORT_NEEDS_YEAR_CODE
  | typeof TIME_ENTRY_RATE_REQUIRED_CODE
  | typeof TIME_ENTRY_REPORT_TOO_LARGE_CODE;

/**
 * Shared structural and handler refusal codes emitted by API handlers that do
 * not yet live in a dedicated `@stll/api-contract` submodule.
 */
export type StructuralApiRefusalCode =
  | "CHAT_PRIVATE_INPUT_ALREADY_SUBMITTED"
  | "CHAT_PRIVATE_INPUT_TARGET_CHANGED"
  | "CHAT_SAVED_CONNECTION_EXISTS"
  | "CHAT_SECRET_UNAVAILABLE"
  | "CHAT_SECRET_UNKNOWN"
  | "FILE_USAGE_CAPACITY_EXCEEDED"
  | "FILE_USAGE_DESTINATION_UNAVAILABLE"
  | "FILE_USAGE_KEY_CONFLICT"
  | "FILE_USAGE_RESERVATION_BUSY"
  | "FILE_USAGE_STORAGE_UNAVAILABLE"
  | "MATTER_REFERENCE_ALLOCATION_EXHAUSTED"
  | "QUOTE_DECISION_UNREADABLE"
  | "access_denied"
  | "access_unavailable"
  | "account_access_unavailable"
  | "account_deletion_otp_expired"
  | "account_deletion_otp_invalid"
  | "account_deletion_sole_owner"
  | "account_deletion_task_reassignment_invalid"
  | "account_deletion_task_reassignment_limit_exceeded"
  | "account_export_account_missing"
  | "account_export_download_unavailable"
  | "account_export_request_limited"
  | "agent_run_refused"
  | "ai-column-input-required"
  | "ai_config_decision_invalid"
  | "ai_config_decision_validation_failed"
  | "ai_config_model_invalid"
  | "ai_config_provider_invalid"
  | "ai_config_provider_validation_failed"
  | "ai_config_stored_unreadable"
  | "ai_member_assignment_required"
  | "already_reviewed"
  | "audio_too_large"
  | "audio_too_long"
  | "audio_unreadable"
  | "author_required"
  | "billing_arrangement_stale"
  | "billing_cap_below_reserved"
  | "billing_cap_exceeded"
  | "billing_currency_mismatch"
  | "chat_limit_reminder_unavailable"
  | "chronology_too_large"
  | "claim_changed_during_recheck"
  | "claim_not_found"
  | "claim_review_actions_exhausted"
  | "claim_set_aside"
  | "conflict"
  | "corpus_maintenance"
  | "current_version_changed"
  | "current_version_not_found"
  | "daily_target_admin_required"
  | "daily_target_member_not_found"
  | "data_export_already_active"
  | "data_export_just_finished"
  | "data_export_not_found"
  | "data_export_part_not_found"
  | "data_export_unavailable"
  | "deepl_key_rejected"
  | "deepl_quota_exceeded"
  | "desktop_account_mismatch"
  | "desktop_account_required"
  | "desktop_device_mismatch"
  | "desktop_proof_expired"
  | "desktop_proof_invalid"
  | "desktop_proof_replayed"
  | "desktop_update_required"
  | "dictation_vocabulary_full"
  | "document_encrypted"
  | "document_format_unsupported"
  | "domain_already_exists"
  | "domain_not_found"
  | "domain_verified_elsewhere"
  | "duplicate_document"
  | "duplicate_target_version"
  | "e_invoice_not_buildable"
  | "edit_session_open"
  | "email_unavailable"
  | "entity_check_cancelled"
  | "entity_limit_reached"
  | "entity_not_found"
  | "entity_read_only"
  | "entity_transfer_source_changed"
  | "entity_transfer_source_in_use"
  | "entity_transfer_source_limit"
  | "entity_transfer_source_referenced"
  | "entry_adjustment_forbidden"
  | "fact_extraction_enqueue_failed"
  | "file_comparison_input_released"
  | "file_corrupted"
  | "file_empty"
  | "file_rejected"
  | "file_scan_failed"
  | "file_unreadable"
  | "flat_fee_expenses"
  | "flat_fee_invoice_locked"
  | "folder_not_found"
  | "folio_collab_base_version_changed"
  | "folio_collab_checkpoint_changed"
  | "folio_collab_generation_changed"
  | "folio_collab_idempotency_key_reused"
  | "folio_collab_room_unreadable"
  | "folio_collab_seed_unavailable"
  | "folio_collab_snapshot_recovery_conflict"
  | "folio_collab_snapshot_revision_changed"
  | "forbidden"
  | "future_date_worked"
  | "hosted_usage_not_configured"
  | "internal_error"
  | "internal_server_error"
  | "invalid_config"
  | "invalid_cursor"
  | "invalid_daily_target"
  | "invalid_date_range"
  | "invalid_date_worked"
  | "invalid_document_name_pattern"
  | "invalid_entry_adjustments"
  | "invalid_idempotency_key"
  | "invalid_internal_timer"
  | "invalid_language"
  | "invalid_time_locked_month"
  | "invalid_time_minimum_unit"
  | "invalid_time_zone"
  | "invalid_vocabulary"
  | "invoice_changed"
  | "invoice_e_invoice_unavailable"
  | "invoice_email_failed"
  | "invoice_email_limit"
  | "invoice_export_empty"
  | "invoice_export_home_currency_vat"
  | "invoice_export_missing_seller"
  | "invoice_export_not_issued"
  | "invoice_export_too_many"
  | "invoice_link_limited"
  | "invoice_link_unavailable"
  | "invoice_link_withdrawn"
  | "invoice_not_renderable"
  | "invoice_not_sendable"
  | "invoice_original_unavailable"
  | "invoice_participation_changed"
  | "invoice_seller_unavailable"
  | "invoice_send_limit"
  | "invoice_send_state_changed"
  | "invoice_total_changed"
  | "last_provider_while_required"
  | "legal_source_document_too_large"
  | "legal_source_entity_limit_reached"
  | "legal_source_file_property_missing"
  | "legal_source_structural_repair_required"
  | "list_column_limit_reached"
  | "list_column_overflow"
  | "list_not_found"
  | "list_or_document_not_found"
  | "list_too_many_facts"
  | "matter_cannot_store_documents"
  | "max_tokens"
  | "mcp_authorization_approval_required"
  | "mcp_oauth_binding_invalid"
  | "mcp_oauth_discovery_failed"
  | "mcp_oauth_discovery_timeout"
  | "mcp_oauth_invalid_grant"
  | "missing_file_field"
  | "missing_scope"
  | "model_output_invalid"
  | "name_search_unsupported"
  | "not_found"
  | "organization_access_state_required"
  | "organization_audit_export_forbidden"
  | "organization_member_capacity_below_members"
  | "organization_member_capacity_reached"
  | "organization_slug_conflict"
  | "organization_slug_update_failed"
  | "outside_edit_window"
  | "pdf_signing_base_version_changed"
  | "pdf_signing_base_version_diverged"
  | "pdf_signing_certificate_conflict"
  | "pdf_signing_certificate_expired"
  | "pdf_signing_certificate_key_usage_forbids_signing"
  | "pdf_signing_certificate_malformed"
  | "pdf_signing_certificate_missing"
  | "pdf_signing_certificate_not_yet_valid"
  | "pdf_signing_certificate_rejected"
  | "pdf_signing_certificate_revoked"
  | "pdf_signing_certificate_unsupported_key_type"
  | "pdf_signing_certified_document"
  | "pdf_signing_digest_mismatch"
  | "pdf_signing_edit_session_open"
  | "pdf_signing_encrypted"
  | "pdf_signing_failed"
  | "pdf_signing_finalize_attempts_exhausted"
  | "pdf_signing_finalize_in_progress"
  | "pdf_signing_finalize_unavailable"
  | "pdf_signing_in_progress"
  | "pdf_signing_not_a_file"
  | "pdf_signing_not_a_pdf"
  | "pdf_signing_permission_revoked"
  | "pdf_signing_prepare_failed"
  | "pdf_signing_session_expired"
  | "pdf_signing_session_not_found"
  | "pdf_signing_signature_conflict"
  | "pdf_signing_signature_invalid"
  | "pdf_signing_stamp_off_page"
  | "pdf_signing_stamp_overflow"
  | "pdf_signing_stamp_page_not_found"
  | "pdf_signing_stamp_placement"
  | "pdf_signing_stamp_time_zone"
  | "pdf_signing_stamp_too_large"
  | "pdf_signing_stamp_too_small"
  | "pdf_signing_stamp_unreadable"
  | "pdf_signing_stamp_unrenderable"
  | "pdf_signing_too_large"
  | "pdf_signing_would_break_signatures"
  | "pending_not_found"
  | "permission_denied"
  | "playbook_scope_unresolved"
  | "previous_version_not_found"
  | "professional_use_statement_outdated"
  | "properties_limit_reached"
  | "provider_error"
  | "provider_key_rejected"
  | "provider_not_found"
  | "provider_rate_limited"
  | "provider_required_to_enforce"
  | "rate_entry_invalid_range"
  | "rate_entry_overlap"
  | "rate_limited"
  | "rate_table_currency_changed"
  | "recording_transcription_in_progress"
  | "recording_unsupported"
  | "registry_configuration_required"
  | "registry_credentials_rejected"
  | "registry_request_failed"
  | "registry_secret_storage_unavailable"
  | "request_aborted"
  | "return_comment_required"
  | "same_version"
  | "scim_operation_failed"
  | "scim_token_limit_reached"
  | "scim_token_not_found"
  | "search_history_country_clear_pending"
  | "search_history_country_unclassifiable"
  | "search_index_unavailable"
  | "seat_limit_reached"
  | "seller_profile_not_found"
  | "service_unavailable"
  | "skill_install_failed"
  | "skill_name_conflict"
  | "skill_team_limit_reached"
  | "skill_user_limit_reached"
  | "source_changed"
  | "source_version_not_found"
  | "sso_domain_dns_failed"
  | "sso_oidc_fetch_failed"
  | "sso_oidc_invalid_document"
  | "sso_oidc_invalid_url"
  | "sso_oidc_issuer_mismatch"
  | "sso_saml_metadata_fetch_failed"
  | "sso_saml_metadata_invalid_document"
  | "sso_saml_metadata_invalid_url"
  | "stream_incomplete"
  | "style_set_cleanup_pending"
  | "target_file_not_found"
  | "time_entry_invoiced"
  | "time_entry_limit"
  | "time_entry_rate_required"
  | "time_entry_selection_changed"
  | "time_entry_timekeeper_required"
  | "timer_admin_required"
  | "timer_completion_changed"
  | "timer_matter_inaccessible"
  | "timer_matter_required"
  | "timer_not_running"
  | "timer_original_entry_changed"
  | "timer_original_entry_inaccessible"
  | "timer_owner_unavailable"
  | "too_many_entries"
  | "too_many_unbilled_items"
  | "transcript_document_too_large"
  | "transcript_folder_removed"
  | "transcript_folder_required"
  | "transcript_matter_entity_limit_reached"
  | "transcript_matter_file_property_missing"
  | "transcription_model_unavailable"
  | "transcription_vocabulary_unsupported"
  | "tree_parent_cycle"
  | "upload_matter_entity_limit_reached"
  | "upload_not_found"
  | "upload_target_invalid"
  | "usage_confirmation_required"
  | "usage_limit_exceeded"
  | "validation_error"
  | "vat_payer_requires_vat_id"
  | "vat_rate_missing"
  | "verification_decision_model_unavailable"
  | "verification_not_found"
  | "workspace_not_active";

/**
 * Closed union of all machine-readable API refusal and error codes.
 */
export type ApiRefusalCode = AssertStringUnion<
  DomainApiRefusalCode | StructuralApiRefusalCode
>;
