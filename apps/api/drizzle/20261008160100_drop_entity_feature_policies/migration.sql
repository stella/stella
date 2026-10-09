-- requires: 20261007090200_entity_feature_visibility
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."anonymization_allowlist_entries";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."cell_metadata";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."correspondence";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."correspondence_attachments";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."correspondence_filers";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."desktop_edit_handoffs";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."desktop_edit_sessions";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."document_processing_runs";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."document_review_parties";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."document_review_reference_passages";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."document_translation_runs";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."document_translation_units";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."docx_suggestions";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."entities";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."entity_links";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."entity_version_ai_summaries";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."entity_versions";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."extracted_content";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."fields";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."file_chat_threads";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."flow_run_steps";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."folio_collab_contributions";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."folio_collab_publications";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."folio_collab_room_tokens";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."folio_collab_rooms";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."justifications";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_claim_review_events";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_claims";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_fact_details";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_generation_candidate_sources";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_generation_candidates";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_generation_sources";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_item_comments";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_item_reviews";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_item_sources";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_items";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_verification_blocks";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_verification_read_receipts";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_verification_runs";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."office_file_evidence";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."pdf_signing_sessions";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."report_exports";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."search_document_preview_passages";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."search_documents";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."task_assignees";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."work_obligation_events";
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Removes the feature fence; existing tenant policies remain in force.
DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."work_obligations";
