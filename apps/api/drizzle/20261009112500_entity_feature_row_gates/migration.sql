-- requires: 20261007090200_entity_feature_visibility
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
ALTER TABLE public."entities" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.entities'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."entities" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.entities'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."entities" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."anonymization_allowlist_entries" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.anonymization_allowlist_entries'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."anonymization_allowlist_entries" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.anonymization_allowlist_entries'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."anonymization_allowlist_entries" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."entity_versions" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.entity_versions'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."entity_versions" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.entity_versions'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."entity_versions" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."cell_metadata" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.cell_metadata'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."cell_metadata" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.cell_metadata'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."cell_metadata" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."correspondence" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.correspondence'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."correspondence" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.correspondence'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."correspondence" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."correspondence_attachments" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.correspondence_attachments'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."correspondence_attachments" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.correspondence_attachments'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."correspondence_attachments" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."correspondence_filers" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.correspondence_filers'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."correspondence_filers" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.correspondence_filers'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."correspondence_filers" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."desktop_edit_sessions" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.desktop_edit_sessions'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."desktop_edit_sessions" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.desktop_edit_sessions'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."desktop_edit_sessions" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."desktop_edit_handoffs" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.desktop_edit_handoffs'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."desktop_edit_handoffs" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.desktop_edit_handoffs'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."desktop_edit_handoffs" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."fields" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.fields'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."fields" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.fields'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."fields" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."document_processing_runs" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.document_processing_runs'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."document_processing_runs" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.document_processing_runs'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."document_processing_runs" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."document_review_parties" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.document_review_parties'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."document_review_parties" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.document_review_parties'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."document_review_parties" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."document_review_reference_passages" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.document_review_reference_passages'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."document_review_reference_passages" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.document_review_reference_passages'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."document_review_reference_passages" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."document_translation_runs" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.document_translation_runs'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."document_translation_runs" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.document_translation_runs'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."document_translation_runs" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."document_translation_units" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.document_translation_units'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."document_translation_units" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.document_translation_units'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."document_translation_units" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."docx_suggestions" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.docx_suggestions'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."docx_suggestions" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.docx_suggestions'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."docx_suggestions" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."entity_links" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.entity_links'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."entity_links" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.entity_links'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."entity_links" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."entity_version_ai_summaries" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.entity_version_ai_summaries'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."entity_version_ai_summaries" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.entity_version_ai_summaries'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."entity_version_ai_summaries" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."extracted_content" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.extracted_content'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."extracted_content" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.extracted_content'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."extracted_content" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."file_chat_threads" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.file_chat_threads'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."file_chat_threads" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.file_chat_threads'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."file_chat_threads" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."flow_run_steps" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.flow_run_steps'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."flow_run_steps" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.flow_run_steps'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."flow_run_steps" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."folio_collab_rooms" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.folio_collab_rooms'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."folio_collab_rooms" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.folio_collab_rooms'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."folio_collab_rooms" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."folio_collab_contributions" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.folio_collab_contributions'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."folio_collab_contributions" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.folio_collab_contributions'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."folio_collab_contributions" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."folio_collab_publications" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.folio_collab_publications'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."folio_collab_publications" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.folio_collab_publications'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."folio_collab_publications" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."folio_collab_room_tokens" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.folio_collab_room_tokens'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."folio_collab_room_tokens" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.folio_collab_room_tokens'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."folio_collab_room_tokens" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."justifications" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.justifications'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."justifications" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.justifications'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."justifications" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."legal_list_verification_runs" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_verification_runs'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."legal_list_verification_runs" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_verification_runs'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."legal_list_verification_runs" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."legal_list_claims" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_organization_ids text[] NOT NULL DEFAULT '{}'::text[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_claims'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."legal_list_claims" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_claims'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."legal_list_claims" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."legal_list_claim_review_events" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_organization_ids text[] NOT NULL DEFAULT '{}'::text[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_claim_review_events'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."legal_list_claim_review_events" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_claim_review_events'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."legal_list_claim_review_events" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."legal_list_fact_details" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_fact_details'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."legal_list_fact_details" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_fact_details'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."legal_list_fact_details" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."legal_list_generation_candidates" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_generation_candidates'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."legal_list_generation_candidates" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_generation_candidates'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."legal_list_generation_candidates" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."legal_list_generation_candidate_sources" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_generation_candidate_sources'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."legal_list_generation_candidate_sources" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_generation_candidate_sources'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."legal_list_generation_candidate_sources" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."legal_list_generation_sources" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_generation_sources'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."legal_list_generation_sources" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_generation_sources'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."legal_list_generation_sources" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."legal_list_item_comments" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_item_comments'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."legal_list_item_comments" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_item_comments'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."legal_list_item_comments" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."legal_list_item_reviews" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_item_reviews'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."legal_list_item_reviews" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_item_reviews'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."legal_list_item_reviews" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."legal_list_item_sources" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_item_sources'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."legal_list_item_sources" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_item_sources'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."legal_list_item_sources" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."legal_list_items" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_items'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."legal_list_items" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_items'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."legal_list_items" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."legal_list_verification_blocks" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_organization_ids text[] NOT NULL DEFAULT '{}'::text[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_verification_blocks'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."legal_list_verification_blocks" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_verification_blocks'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."legal_list_verification_blocks" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."legal_list_verification_read_receipts" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_verification_read_receipts'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."legal_list_verification_read_receipts" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.legal_list_verification_read_receipts'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."legal_list_verification_read_receipts" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."office_file_evidence" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.office_file_evidence'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."office_file_evidence" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.office_file_evidence'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."office_file_evidence" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."pdf_signing_sessions" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pdf_signing_sessions'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."pdf_signing_sessions" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pdf_signing_sessions'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."pdf_signing_sessions" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."report_exports" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.report_exports'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."report_exports" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.report_exports'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."report_exports" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."search_document_preview_passages" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.search_document_preview_passages'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."search_document_preview_passages" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.search_document_preview_passages'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."search_document_preview_passages" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."search_documents" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.search_documents'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."search_documents" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.search_documents'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."search_documents" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."task_assignees" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS entity_feature_workspace_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.task_assignees'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."task_assignees" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.task_assignees'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."task_assignees" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."work_obligation_events" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.work_obligation_events'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."work_obligation_events" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.work_obligation_events'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."work_obligation_events" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
ALTER TABLE public."work_obligations" ADD COLUMN IF NOT EXISTS entity_feature_gate text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.work_obligations'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public."work_obligations" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;
--> statement-breakpoint
DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.work_obligations'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public."work_obligations" ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.entity_feature_gate_graph() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $graph$ SELECT $metadata${"entities":{"tableName":"entities","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'list_item_type', p.\"list_item_type\", 'entity_feature_gate', p.\"entity_feature_gate\")","refs":[],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":0},"anonymization_allowlist_entries":{"tableName":"anonymization_allowlist_entries","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":false,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":1},"entity_versions":{"tableName":"entity_versions","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_id', p.\"entity_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":2},"cell_metadata":{"tableName":"cell_metadata","primaryKey":["entity_version_id","property_id"],"projection":"jsonb_build_object('workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_version_id', p.\"entity_version_id\", 'property_id', p.\"property_id\")","refs":[{"column":"entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":3},"correspondence":{"tableName":"correspondence","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'source_entity_id', p.\"source_entity_id\")","refs":[{"column":"source_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":false,"needsOrganization":false,"order":4},"correspondence_attachments":{"tableName":"correspondence_attachments","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'correspondence_id', p.\"correspondence_id\", 'entity_id', p.\"entity_id\")","refs":[{"column":"correspondence_id","parent":"correspondence","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":true},{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":false,"needsOrganization":false,"order":5},"correspondence_filers":{"tableName":"correspondence_filers","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'correspondence_id', p.\"correspondence_id\")","refs":[{"column":"correspondence_id","parent":"correspondence","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":true}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":false,"needsOrganization":false,"order":6},"desktop_edit_sessions":{"tableName":"desktop_edit_sessions","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\", 'base_version_id', p.\"base_version_id\", 'finalized_version_id', p.\"finalized_version_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"base_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false},{"column":"finalized_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":7},"desktop_edit_handoffs":{"tableName":"desktop_edit_handoffs","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'desktop_session_id', p.\"desktop_session_id\", 'entity_id', p.\"entity_id\")","refs":[{"column":"desktop_session_id","parent":"desktop_edit_sessions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false},{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":8},"fields":{"tableName":"fields","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_version_id', p.\"entity_version_id\")","refs":[{"column":"entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":9},"document_processing_runs":{"tableName":"document_processing_runs","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\", 'entity_version_id', p.\"entity_version_id\", 'field_id', p.\"field_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false},{"column":"field_id","parent":"fields","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":10},"document_review_parties":{"tableName":"document_review_parties","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\", 'entity_version_id', p.\"entity_version_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":11},"document_review_reference_passages":{"tableName":"document_review_reference_passages","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_id', p.\"entity_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":false,"needsOrganization":false,"order":12},"document_translation_runs":{"tableName":"document_translation_runs","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":13},"document_translation_units":{"tableName":"document_translation_units","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'run_id', p.\"run_id\")","refs":[{"column":"run_id","parent":"document_translation_runs","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":true}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":14},"docx_suggestions":{"tableName":"docx_suggestions","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_id', p.\"entity_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":15},"entity_links":{"tableName":"entity_links","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'source_entity_id', p.\"source_entity_id\", 'target_entity_id', p.\"target_entity_id\")","refs":[{"column":"source_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false},{"column":"target_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":16},"entity_version_ai_summaries":{"tableName":"entity_version_ai_summaries","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\", 'entity_version_id', p.\"entity_version_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":17},"extracted_content":{"tableName":"extracted_content","primaryKey":["entity_id"],"projection":"jsonb_build_object('workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\", 'source_entity_version_id', p.\"source_entity_version_id\", 'source_field_id', p.\"source_field_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"source_entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false},{"column":"source_field_id","parent":"fields","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":18},"file_chat_threads":{"tableName":"file_chat_threads","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\", 'field_id', p.\"field_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"field_id","parent":"fields","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":19},"flow_run_steps":{"tableName":"flow_run_steps","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'review_task_entity_id', p.\"review_task_entity_id\")","refs":[{"column":"review_task_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":20},"folio_collab_rooms":{"tableName":"folio_collab_rooms","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_id', p.\"entity_id\", 'base_version_id', p.\"base_version_id\", 'source_version_id', p.\"source_version_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"base_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"source_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":21},"folio_collab_contributions":{"tableName":"folio_collab_contributions","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_id', p.\"entity_id\", 'since_version_id', p.\"since_version_id\", 'room_id', p.\"room_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"since_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"room_id","parent":"folio_collab_rooms","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":22},"folio_collab_publications":{"tableName":"folio_collab_publications","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_id', p.\"entity_id\", 'entity_version_id', p.\"entity_version_id\", 'room_id', p.\"room_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"room_id","parent":"folio_collab_rooms","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":23},"folio_collab_room_tokens":{"tableName":"folio_collab_room_tokens","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'room_id', p.\"room_id\")","refs":[{"column":"room_id","parent":"folio_collab_rooms","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":24},"justifications":{"tableName":"justifications","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'field_id', p.\"field_id\")","refs":[{"column":"field_id","parent":"fields","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":25},"legal_list_verification_runs":{"tableName":"legal_list_verification_runs","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_id', p.\"entity_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":false,"needsOrganization":false,"order":26},"legal_list_claims":{"tableName":"legal_list_claims","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_organization_ids', p.\"entity_feature_organization_ids\", 'run_id', p.\"run_id\")","refs":[{"column":"run_id","parent":"legal_list_verification_runs","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":true,"order":27},"legal_list_claim_review_events":{"tableName":"legal_list_claim_review_events","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_organization_ids', p.\"entity_feature_organization_ids\", 'claim_id', p.\"claim_id\")","refs":[{"column":"claim_id","parent":"legal_list_claims","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":true,"order":28},"legal_list_fact_details":{"tableName":"legal_list_fact_details","primaryKey":["item_entity_id"],"projection":"jsonb_build_object('workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'item_entity_id', p.\"item_entity_id\")","refs":[{"column":"item_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":29},"legal_list_generation_candidates":{"tableName":"legal_list_generation_candidates","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'accepted_entity_id', p.\"accepted_entity_id\")","refs":[{"column":"accepted_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":30},"legal_list_generation_candidate_sources":{"tableName":"legal_list_generation_candidate_sources","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'source_entity_id', p.\"source_entity_id\", 'source_entity_version_id', p.\"source_entity_version_id\", 'candidate_id', p.\"candidate_id\")","refs":[{"column":"source_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"source_entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"candidate_id","parent":"legal_list_generation_candidates","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":31},"legal_list_generation_sources":{"tableName":"legal_list_generation_sources","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'source_entity_id', p.\"source_entity_id\", 'source_entity_version_id', p.\"source_entity_version_id\")","refs":[{"column":"source_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"source_entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":32},"legal_list_item_comments":{"tableName":"legal_list_item_comments","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'item_entity_id', p.\"item_entity_id\")","refs":[{"column":"item_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":33},"legal_list_item_reviews":{"tableName":"legal_list_item_reviews","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'item_entity_id', p.\"item_entity_id\")","refs":[{"column":"item_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":34},"legal_list_item_sources":{"tableName":"legal_list_item_sources","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'item_entity_id', p.\"item_entity_id\", 'source_entity_id', p.\"source_entity_id\", 'source_entity_version_id', p.\"source_entity_version_id\")","refs":[{"column":"item_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"source_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"source_entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":35},"legal_list_items":{"tableName":"legal_list_items","primaryKey":["entity_id"],"projection":"jsonb_build_object('workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_id', p.\"entity_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":36},"legal_list_verification_blocks":{"tableName":"legal_list_verification_blocks","primaryKey":["run_id","ordinal"],"projection":"jsonb_build_object('workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_organization_ids', p.\"entity_feature_organization_ids\", 'run_id', p.\"run_id\", 'ordinal', p.\"ordinal\")","refs":[{"column":"run_id","parent":"legal_list_verification_runs","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":true,"order":37},"legal_list_verification_read_receipts":{"tableName":"legal_list_verification_read_receipts","primaryKey":["organization_id","workspace_id","run_id","user_id"],"projection":"jsonb_build_object('workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'run_id', p.\"run_id\", 'user_id', p.\"user_id\")","refs":[{"column":"run_id","parent":"legal_list_verification_runs","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":true}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":false,"needsOrganization":false,"order":38},"office_file_evidence":{"tableName":"office_file_evidence","primaryKey":["organization_id","workspace_id","entity_version_id","field_id","source_file_id","source_sha256_hex","parser_version"],"projection":"jsonb_build_object('workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\", 'entity_version_id', p.\"entity_version_id\", 'field_id', p.\"field_id\", 'source_file_id', p.\"source_file_id\", 'source_sha256_hex', p.\"source_sha256_hex\", 'parser_version', p.\"parser_version\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false},{"column":"field_id","parent":"fields","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":39},"pdf_signing_sessions":{"tableName":"pdf_signing_sessions","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\", 'base_version_id', p.\"base_version_id\", 'finalized_version_id', p.\"finalized_version_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"base_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false},{"column":"finalized_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":40},"report_exports":{"tableName":"report_exports","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'result_entity_id', p.\"result_entity_id\", 'result_field_id', p.\"result_field_id\")","refs":[{"column":"result_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false},{"column":"result_field_id","parent":"fields","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":41},"search_document_preview_passages":{"tableName":"search_document_preview_passages","primaryKey":["entity_id","generation","ordinal"],"projection":"jsonb_build_object('workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\", 'generation', p.\"generation\", 'ordinal', p.\"ordinal\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":42},"search_documents":{"tableName":"search_documents","primaryKey":["entity_id"],"projection":"jsonb_build_object('workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":43},"task_assignees":{"tableName":"task_assignees","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":44},"work_obligation_events":{"tableName":"work_obligation_events","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'obligation_entity_id', p.\"obligation_entity_id\")","refs":[{"column":"obligation_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":45},"work_obligations":{"tableName":"work_obligations","primaryKey":["entity_id"],"projection":"jsonb_build_object('workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_id', p.\"entity_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":46}}$metadata$::jsonb $graph$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.entity_feature_gate_graph() FROM PUBLIC;
--> statement-breakpoint
DO $ownership$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND public.entity_feature_gate_graph() ? c.relname AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = 'stella')) THEN RAISE EXCEPTION 'The application role must not own entity feature tables'; END IF; IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND public.entity_feature_gate_graph() ? c.relname AND c.relowner <> current_user::regrole) AND NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN RAISE EXCEPTION 'Entity feature maintenance must run as the table owner or a bypass role'; END IF; END $ownership$;
--> statement-breakpoint
DO $role$
DECLARE maintenance_role oid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'stella_entity_gate') THEN
    BEGIN
      CREATE ROLE stella_entity_gate NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'Entity feature gate migration requires CREATEROLE to create its dedicated maintenance role';
    END;
  END IF;
  SELECT oid INTO maintenance_role FROM pg_catalog.pg_roles WHERE rolname = 'stella_entity_gate'
    AND NOT (rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication);
  IF maintenance_role IS NULL THEN
    RAISE EXCEPTION 'stella_entity_gate must be a non-login, non-inheriting, non-bypass maintenance role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = maintenance_role
      OR (roleid = maintenance_role AND (member <> current_user::regrole OR inherit_option OR set_option))) THEN
    RAISE EXCEPTION 'stella_entity_gate must not grant runtime membership or inherit other roles';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relowner = maintenance_role)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proowner = maintenance_role
      AND (pronamespace <> 'public'::regnamespace OR proname NOT IN
        ('entity_feature_gate_value', 'entity_feature_gate_write', 'entity_feature_gate_propagate', 'entity_feature_gate_repair_missing', 'entity_feature_gate_backfill'))) THEN
    RAISE EXCEPTION 'stella_entity_gate may own only the gate maintenance functions';
  END IF;
END
$role$;
--> statement-breakpoint
-- The migrator keeps administration rights for retries, without runtime access.
-- stella-migration-safety: reviewed grant-privileges - The migrator can administer retries but cannot inherit maintenance data privileges.
GRANT stella_entity_gate TO CURRENT_USER WITH INHERIT FALSE;
--> statement-breakpoint
-- stella-migration-safety: reviewed grant-privileges - Temporary SET membership creates private function ownership and is disabled before the first commit.
GRANT stella_entity_gate TO CURRENT_USER WITH SET TRUE;
--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA public TO stella_entity_gate;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.entity_feature_gate_graph() TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "list_item_type", "entity_feature_gate"), UPDATE ("entity_feature_gate") ON public."entities" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "organization_id", "entity_feature_gate", "entity_feature_workspace_ids", "entity_id"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."anonymization_allowlist_entries" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "entity_id"), UPDATE ("entity_feature_gate") ON public."entity_versions" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("workspace_id", "entity_feature_gate", "entity_feature_workspace_ids", "entity_version_id", "property_id"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."cell_metadata" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "organization_id", "entity_feature_gate", "source_entity_id"), UPDATE ("entity_feature_gate") ON public."correspondence" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "organization_id", "entity_feature_gate", "correspondence_id", "entity_id"), UPDATE ("entity_feature_gate") ON public."correspondence_attachments" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "organization_id", "entity_feature_gate", "correspondence_id"), UPDATE ("entity_feature_gate") ON public."correspondence_filers" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "entity_feature_workspace_ids", "entity_id", "base_version_id", "finalized_version_id"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."desktop_edit_sessions" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "entity_feature_workspace_ids", "desktop_session_id", "entity_id"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."desktop_edit_handoffs" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "entity_feature_workspace_ids", "entity_version_id"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."fields" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "organization_id", "entity_feature_gate", "entity_feature_workspace_ids", "entity_id", "entity_version_id", "field_id"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."document_processing_runs" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "organization_id", "entity_feature_gate", "entity_feature_workspace_ids", "entity_id", "entity_version_id"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."document_review_parties" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "organization_id", "entity_feature_gate", "entity_id"), UPDATE ("entity_feature_gate") ON public."document_review_reference_passages" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "organization_id", "entity_feature_gate", "entity_feature_workspace_ids", "entity_id"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."document_translation_runs" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "organization_id", "entity_feature_gate", "entity_feature_workspace_ids", "run_id"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."document_translation_units" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "entity_id"), UPDATE ("entity_feature_gate") ON public."docx_suggestions" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "entity_feature_workspace_ids", "source_entity_id", "target_entity_id"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."entity_links" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "organization_id", "entity_feature_gate", "entity_feature_workspace_ids", "entity_id", "entity_version_id"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."entity_version_ai_summaries" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("workspace_id", "organization_id", "entity_feature_gate", "entity_feature_workspace_ids", "entity_id", "source_entity_version_id", "source_field_id"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."extracted_content" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "organization_id", "entity_feature_gate", "entity_feature_workspace_ids", "entity_id", "field_id"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."file_chat_threads" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "entity_feature_workspace_ids", "review_task_entity_id"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."flow_run_steps" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "entity_id", "base_version_id", "source_version_id"), UPDATE ("entity_feature_gate") ON public."folio_collab_rooms" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "entity_id", "since_version_id", "room_id"), UPDATE ("entity_feature_gate") ON public."folio_collab_contributions" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "entity_id", "entity_version_id", "room_id"), UPDATE ("entity_feature_gate") ON public."folio_collab_publications" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "room_id"), UPDATE ("entity_feature_gate") ON public."folio_collab_room_tokens" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "entity_feature_workspace_ids", "field_id"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."justifications" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "organization_id", "entity_feature_gate", "entity_id"), UPDATE ("entity_feature_gate") ON public."legal_list_verification_runs" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "entity_feature_organization_ids", "run_id"), UPDATE ("entity_feature_gate", "entity_feature_organization_ids") ON public."legal_list_claims" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "entity_feature_organization_ids", "claim_id"), UPDATE ("entity_feature_gate", "entity_feature_organization_ids") ON public."legal_list_claim_review_events" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("workspace_id", "entity_feature_gate", "item_entity_id"), UPDATE ("entity_feature_gate") ON public."legal_list_fact_details" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "entity_feature_workspace_ids", "accepted_entity_id"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."legal_list_generation_candidates" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "entity_feature_workspace_ids", "source_entity_id", "source_entity_version_id", "candidate_id"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."legal_list_generation_candidate_sources" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "source_entity_id", "source_entity_version_id"), UPDATE ("entity_feature_gate") ON public."legal_list_generation_sources" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "item_entity_id"), UPDATE ("entity_feature_gate") ON public."legal_list_item_comments" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "item_entity_id"), UPDATE ("entity_feature_gate") ON public."legal_list_item_reviews" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "item_entity_id", "source_entity_id", "source_entity_version_id"), UPDATE ("entity_feature_gate") ON public."legal_list_item_sources" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("workspace_id", "entity_feature_gate", "entity_id"), UPDATE ("entity_feature_gate") ON public."legal_list_items" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("workspace_id", "entity_feature_gate", "entity_feature_organization_ids", "run_id", "ordinal"), UPDATE ("entity_feature_gate", "entity_feature_organization_ids") ON public."legal_list_verification_blocks" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("workspace_id", "organization_id", "entity_feature_gate", "run_id", "user_id"), UPDATE ("entity_feature_gate") ON public."legal_list_verification_read_receipts" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("workspace_id", "organization_id", "entity_feature_gate", "entity_feature_workspace_ids", "entity_id", "entity_version_id", "field_id", "source_file_id", "source_sha256_hex", "parser_version"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."office_file_evidence" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "entity_feature_workspace_ids", "entity_id", "base_version_id", "finalized_version_id"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."pdf_signing_sessions" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "entity_feature_workspace_ids", "result_entity_id", "result_field_id"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."report_exports" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("workspace_id", "organization_id", "entity_feature_gate", "entity_feature_workspace_ids", "entity_id", "generation", "ordinal"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."search_document_preview_passages" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("workspace_id", "organization_id", "entity_feature_gate", "entity_feature_workspace_ids", "entity_id"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."search_documents" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "entity_feature_workspace_ids", "entity_id"), UPDATE ("entity_feature_gate", "entity_feature_workspace_ids") ON public."task_assignees" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("id", "workspace_id", "entity_feature_gate", "obligation_entity_id"), UPDATE ("entity_feature_gate") ON public."work_obligation_events" TO stella_entity_gate;
--> statement-breakpoint
GRANT SELECT ("workspace_id", "entity_feature_gate", "entity_id"), UPDATE ("entity_feature_gate") ON public."work_obligations" TO stella_entity_gate;
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."anonymization_allowlist_entries";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."anonymization_allowlist_entries" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."cell_metadata";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."cell_metadata" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."correspondence";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."correspondence" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."correspondence_attachments";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."correspondence_attachments" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."correspondence_filers";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."correspondence_filers" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."desktop_edit_handoffs";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."desktop_edit_handoffs" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."desktop_edit_sessions";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."desktop_edit_sessions" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."document_processing_runs";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."document_processing_runs" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."document_review_parties";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."document_review_parties" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."document_review_reference_passages";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."document_review_reference_passages" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."document_translation_runs";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."document_translation_runs" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."document_translation_units";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."document_translation_units" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."docx_suggestions";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."docx_suggestions" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."entities";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."entities" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."entity_links";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."entity_links" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."entity_version_ai_summaries";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."entity_version_ai_summaries" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."entity_versions";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."entity_versions" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."extracted_content";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."extracted_content" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."fields";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."fields" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."file_chat_threads";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."file_chat_threads" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."flow_run_steps";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."flow_run_steps" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."folio_collab_contributions";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."folio_collab_contributions" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."folio_collab_publications";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."folio_collab_publications" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."folio_collab_room_tokens";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."folio_collab_room_tokens" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."folio_collab_rooms";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."folio_collab_rooms" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."justifications";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."justifications" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."legal_list_claim_review_events";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."legal_list_claim_review_events" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."legal_list_claims";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."legal_list_claims" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."legal_list_fact_details";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."legal_list_fact_details" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."legal_list_generation_candidate_sources";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."legal_list_generation_candidate_sources" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."legal_list_generation_candidates";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."legal_list_generation_candidates" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."legal_list_generation_sources";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."legal_list_generation_sources" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."legal_list_item_comments";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."legal_list_item_comments" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."legal_list_item_reviews";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."legal_list_item_reviews" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."legal_list_item_sources";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."legal_list_item_sources" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."legal_list_items";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."legal_list_items" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."legal_list_verification_blocks";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."legal_list_verification_blocks" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."legal_list_verification_read_receipts";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."legal_list_verification_read_receipts" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."legal_list_verification_runs";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."legal_list_verification_runs" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."office_file_evidence";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."office_file_evidence" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."pdf_signing_sessions";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."pdf_signing_sessions" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."report_exports";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."report_exports" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."search_document_preview_passages";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."search_document_preview_passages" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."search_documents";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."search_documents" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."task_assignees";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."task_assignees" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."work_obligation_events";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."work_obligation_events" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreate only the dedicated maintenance role policy; owner and application access remain fenced.
DROP POLICY IF EXISTS "entity_feature_gate_maintenance" ON "public"."work_obligations";
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."work_obligations" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
SET LOCAL ROLE stella_entity_gate;
--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - Dedicated-role trigger routines derive stored visibility and lock trusted graph parents; fixed search_path and no PUBLIC execute.
CREATE OR REPLACE FUNCTION public.entity_feature_gate_value(table_name text, row_data jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog SET row_security = on AS $function$
DECLARE
  descriptor jsonb;
  reference jsonb;
  parent_descriptor jsonb;
  parent_row jsonb;
  parent_value jsonb;
  state text := 'open';
  workspace_ids uuid[] := '{}';
  organization_ids text[] := '{}';
BEGIN
  IF table_name = 'entities' THEN
    RETURN jsonb_build_object('state', CASE WHEN row_data->>'list_item_type' IS NULL
      OR row_data->>'list_item_type' = 'task' THEN 'open' ELSE 'legal-lists' END,
      'workspaceIds', '[]'::jsonb, 'organizationIds', '[]'::jsonb);
  END IF;
  descriptor := public.entity_feature_gate_graph() -> table_name;
  IF descriptor IS NULL THEN
    RAISE EXCEPTION 'Unregistered entity feature relation: %', table_name;
  END IF;
  -- References are ordered by parent relation and column; concurrent child
  -- writers take compatible SHARE locks, which exclude parent reclassification.
  FOR reference IN SELECT value FROM jsonb_array_elements(descriptor->'refs') LOOP
    IF row_data->>(reference->>'column') IS NULL THEN CONTINUE; END IF;
    parent_descriptor := public.entity_feature_gate_graph() -> (reference->>'parent');
    parent_row := NULL;
    EXECUTE format('SELECT %s FROM public.%I p WHERE p.id = $1::uuid FOR SHARE',
      parent_descriptor->>'projection', reference->>'parent')
      INTO parent_row USING row_data->>(reference->>'column');
    IF parent_row IS NULL THEN
      state := 'missing';
      CONTINUE;
    END IF;
    IF reference->>'parent' = 'entities'
      OR parent_row->>'entity_feature_gate' = 'pending' THEN
      parent_value := public.entity_feature_gate_value(reference->>'parent', parent_row);
    ELSE
      parent_value := jsonb_build_object('state', parent_row->>'entity_feature_gate',
        'workspaceIds', coalesce(parent_row->'entity_feature_workspace_ids', '[]'::jsonb),
        'organizationIds', coalesce(parent_row->'entity_feature_organization_ids', '[]'::jsonb));
    END IF;
    IF parent_value->>'state' = 'missing' THEN state := 'missing';
    ELSIF state = 'open' AND parent_value->>'state' = 'legal-lists' THEN state := 'legal-lists';
    ELSIF parent_value->>'state' NOT IN ('open', 'legal-lists') THEN
      RAISE EXCEPTION 'Invalid parent entity feature gate';
    END IF;
    -- Paired row scope already enforces these requirements. Only inherited
    -- scope needs array accumulation and normalization.
    IF (descriptor->>'needsWorkspace')::boolean THEN
      workspace_ids := workspace_ids || ARRAY(SELECT value::uuid
        FROM jsonb_array_elements_text(parent_value->'workspaceIds'));
      IF (parent_descriptor->>'ownWorkspace')::boolean THEN
        workspace_ids := array_append(workspace_ids, (parent_row->>'workspace_id')::uuid);
      END IF;
    END IF;
    IF (descriptor->>'needsOrganization')::boolean THEN
      organization_ids := organization_ids || ARRAY(SELECT value
        FROM jsonb_array_elements_text(parent_value->'organizationIds'));
      IF (parent_descriptor->>'ownOrganization')::boolean THEN
        organization_ids := array_append(organization_ids, parent_row->>'organization_id');
      END IF;
    END IF;
  END LOOP;
  IF (descriptor->>'needsWorkspace')::boolean THEN
    SELECT coalesce(array_agg(DISTINCT id ORDER BY id), '{}') INTO workspace_ids
      FROM unnest(workspace_ids) id
      WHERE NOT ((descriptor->>'ownWorkspace')::boolean
        AND id = (row_data->>'workspace_id')::uuid);
  END IF;
  IF (descriptor->>'needsOrganization')::boolean THEN
    SELECT coalesce(array_agg(DISTINCT id ORDER BY id), '{}') INTO organization_ids
      FROM unnest(organization_ids) id
      WHERE NOT ((descriptor->>'ownOrganization')::boolean
        AND id = row_data->>'organization_id');
  END IF;
  RETURN jsonb_build_object('state', state, 'workspaceIds', workspace_ids,
    'organizationIds', organization_ids);
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.entity_feature_gate_value(text, jsonb) FROM PUBLIC;
--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - Dedicated-role trigger routines derive stored visibility and lock trusted graph parents; fixed search_path and no PUBLIC execute.
CREATE OR REPLACE FUNCTION public.entity_feature_gate_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog SET row_security = on AS $function$
DECLARE
  row_data jsonb;
  gate jsonb;
  patch jsonb;
  parent_gate text;
  parent_workspace uuid;
  parent_entity uuid;
BEGIN
  -- The root gate depends only on this row, including updates to cached input.
  IF TG_TABLE_NAME = 'entities' THEN
    NEW.entity_feature_gate := CASE WHEN NEW.list_item_type IS NULL
      OR NEW.list_item_type = 'task' THEN 'open' ELSE 'legal-lists' END;
    RETURN NEW;
  END IF;
  -- These single-parent paths use cached static plans and scalar reads. Do not
  -- serialize file contents or search text just to derive visibility.
  IF TG_TABLE_NAME = 'entity_versions' OR TG_TABLE_NAME = 'search_documents' THEN
    SELECT CASE WHEN p.list_item_type IS NULL OR p.list_item_type = 'task'
      THEN 'open' ELSE 'legal-lists' END, p.workspace_id
      INTO parent_gate, parent_workspace
      FROM public.entities p WHERE p.id = NEW.entity_id FOR SHARE;
    NEW.entity_feature_gate := coalesce(parent_gate, 'missing');
    IF TG_TABLE_NAME = 'search_documents' THEN
      NEW.entity_feature_workspace_ids := CASE
        WHEN parent_workspace IS NOT NULL AND parent_workspace <> NEW.workspace_id
        THEN ARRAY[parent_workspace] ELSE '{}'::uuid[] END;
    END IF;
  ELSIF TG_TABLE_NAME = 'fields' THEN
    SELECT p.entity_feature_gate, p.workspace_id, p.entity_id
      INTO parent_gate, parent_workspace, parent_entity
      FROM public.entity_versions p WHERE p.id = NEW.entity_version_id FOR SHARE;
    -- A pending version can exist during backfill. Derive it from the locked
    -- entity rather than persisting a pending child gate.
    IF parent_gate = 'pending' THEN
      SELECT CASE WHEN p.list_item_type IS NULL OR p.list_item_type = 'task'
        THEN 'open' ELSE 'legal-lists' END INTO parent_gate
        FROM public.entities p WHERE p.id = parent_entity FOR SHARE;
    END IF;
    NEW.entity_feature_gate := coalesce(parent_gate, 'missing');
    NEW.entity_feature_workspace_ids := CASE
      WHEN parent_workspace IS NOT NULL AND parent_workspace <> NEW.workspace_id
      THEN ARRAY[parent_workspace] ELSE '{}'::uuid[] END;
  ELSE
    row_data := to_jsonb(NEW);
    gate := public.entity_feature_gate_value(TG_TABLE_NAME, row_data);
  END IF;
  IF TG_TABLE_NAME IN ('entity_versions', 'fields', 'search_documents') THEN
    IF TG_OP = 'INSERT' AND NEW.entity_feature_gate = 'missing'
      AND current_setting('role', true) = 'stella' THEN
      RAISE EXCEPTION 'The referenced entity feature parent no longer exists'
        USING ERRCODE = '23503', TABLE = TG_TABLE_NAME;
    END IF;
    RETURN NEW;
  END IF;
  patch := jsonb_build_object('entity_feature_gate', gate->>'state');
  -- A scoped child write may wait for a parent that moved or disappeared.
  -- Preserve the FK-shaped refusal its caller already handles; maintenance
  -- can still persist denied gates for historical missing-parent rows.
  IF TG_OP = 'INSERT' AND gate->>'state' = 'missing'
    AND current_setting('role', true) = 'stella' THEN
    RAISE EXCEPTION 'The referenced entity feature parent no longer exists'
      USING ERRCODE = '23503', TABLE = TG_TABLE_NAME;
  END IF;
  IF row_data ? 'entity_feature_workspace_ids' THEN
    patch := patch || jsonb_build_object('entity_feature_workspace_ids', gate->'workspaceIds');
  END IF;
  IF row_data ? 'entity_feature_organization_ids' THEN
    patch := patch || jsonb_build_object('entity_feature_organization_ids', gate->'organizationIds');
  END IF;
  -- A paired scope is enforced by its FK after this BEFORE trigger. Invalid
  -- paired references must reach that constraint, preserving its error identity.
  -- Input cannot forge a gate, including owner writes and propagation updates.
  NEW := jsonb_populate_record(NEW, patch);
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.entity_feature_gate_write() FROM PUBLIC;
--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - Dedicated-role trigger routines derive stored visibility and lock trusted graph parents; fixed search_path and no PUBLIC execute.
CREATE OR REPLACE FUNCTION public.entity_feature_gate_propagate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog SET row_security = on
SET plan_cache_mode = force_generic_plan AS $function$
DECLARE
  changed_ids uuid[];
  changed_workspace_ids uuid[];
  matching_children text[];
  child_name text;
BEGIN
  -- Generated by apps/api/scripts/generate-entity-feature-gate-propagation.ts.
  -- ID arrays vary per write; generic plans avoid repeated custom planning.
  -- Cache descendant probes and writes; transition rows supply only IDs and
  -- gate inputs. Keep orphan repair and the parent SHARE-lock protocol intact.
  IF TG_TABLE_NAME = 'entities' THEN
    IF TG_OP = 'UPDATE' THEN
      WITH changed AS MATERIALIZED (
        SELECT o.id AS old_id, n.id AS new_id
        FROM entity_feature_old_rows o FULL JOIN entity_feature_new_rows n USING (id)
        WHERE ROW(o."id", o."list_item_type", o."workspace_id") IS DISTINCT FROM ROW(n."id", n."list_item_type", n."workspace_id"))
      SELECT ARRAY(SELECT old_id FROM changed WHERE old_id IS NOT NULL
          UNION SELECT new_id FROM changed WHERE new_id IS NOT NULL),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o
          UNION SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT ARRAY(SELECT id FROM entity_feature_old_rows),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o)
        INTO changed_ids, changed_workspace_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM entity_feature_new_rows),
        ARRAY(SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    END IF;
    IF cardinality(changed_ids) = 0 THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Entity feature propagation requires a current snapshot'
        USING ERRCODE = '40001';
    END IF;
    SELECT ARRAY(SELECT candidates.child_name FROM (
        SELECT 'anonymization_allowlist_entries'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."anonymization_allowlist_entries" c WHERE (c."entity_id" = ANY(changed_ids)))
        UNION ALL
        SELECT 'correspondence'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."correspondence" c WHERE (c."source_entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'correspondence_attachments'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."correspondence_attachments" c WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'desktop_edit_handoffs'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."desktop_edit_handoffs" c WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'desktop_edit_sessions'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."desktop_edit_sessions" c WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'document_processing_runs'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."document_processing_runs" c WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'document_review_parties'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."document_review_parties" c WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'document_review_reference_passages'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."document_review_reference_passages" c WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'document_translation_runs'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."document_translation_runs" c WHERE (c."entity_id" = ANY(changed_ids)))
        UNION ALL
        SELECT 'docx_suggestions'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."docx_suggestions" c WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'entity_links'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."entity_links" c WHERE (c."source_entity_id" = ANY(changed_ids)) OR (c."target_entity_id" = ANY(changed_ids)))
        UNION ALL
        SELECT 'entity_version_ai_summaries'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."entity_version_ai_summaries" c WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'entity_versions'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."entity_versions" c WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'extracted_content'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."extracted_content" c WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'file_chat_threads'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."file_chat_threads" c WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'flow_run_steps'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."flow_run_steps" c WHERE (c."review_task_entity_id" = ANY(changed_ids)))
        UNION ALL
        SELECT 'folio_collab_contributions'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."folio_collab_contributions" c WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'folio_collab_publications'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."folio_collab_publications" c WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'folio_collab_rooms'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."folio_collab_rooms" c WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'legal_list_fact_details'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_fact_details" c WHERE (c."item_entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'legal_list_generation_candidate_sources'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_generation_candidate_sources" c WHERE (c."source_entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'legal_list_generation_candidates'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_generation_candidates" c WHERE (c."accepted_entity_id" = ANY(changed_ids)))
        UNION ALL
        SELECT 'legal_list_generation_sources'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_generation_sources" c WHERE (c."source_entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'legal_list_item_comments'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_item_comments" c WHERE (c."item_entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'legal_list_item_reviews'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_item_reviews" c WHERE (c."item_entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'legal_list_item_sources'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_item_sources" c WHERE (c."item_entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)) OR (c."source_entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'legal_list_items'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_items" c WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'legal_list_verification_runs'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_verification_runs" c WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'office_file_evidence'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."office_file_evidence" c WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'pdf_signing_sessions'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."pdf_signing_sessions" c WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'report_exports'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."report_exports" c WHERE (c."result_entity_id" = ANY(changed_ids)))
        UNION ALL
        SELECT 'search_document_preview_passages'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."search_document_preview_passages" c WHERE (c."entity_id" = ANY(changed_ids)))
        UNION ALL
        SELECT 'search_documents'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."search_documents" c WHERE (c."entity_id" = ANY(changed_ids)))
        UNION ALL
        SELECT 'task_assignees'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."task_assignees" c WHERE (c."entity_id" = ANY(changed_ids)))
        UNION ALL
        SELECT 'work_obligation_events'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."work_obligation_events" c WHERE (c."obligation_entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'work_obligations'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."work_obligations" c WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))) candidates ORDER BY candidates.child_name)
      INTO matching_children;
    FOREACH child_name IN ARRAY matching_children LOOP
      IF child_name = 'anonymization_allowlist_entries' THEN
          UPDATE public."anonymization_allowlist_entries" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids));
      ELSIF child_name = 'correspondence' THEN
          UPDATE public."correspondence" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."source_entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'correspondence_attachments' THEN
          UPDATE public."correspondence_attachments" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'desktop_edit_handoffs' THEN
          UPDATE public."desktop_edit_handoffs" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'desktop_edit_sessions' THEN
          UPDATE public."desktop_edit_sessions" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'document_processing_runs' THEN
          UPDATE public."document_processing_runs" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'document_review_parties' THEN
          UPDATE public."document_review_parties" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'document_review_reference_passages' THEN
          UPDATE public."document_review_reference_passages" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'document_translation_runs' THEN
          UPDATE public."document_translation_runs" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids));
      ELSIF child_name = 'docx_suggestions' THEN
          UPDATE public."docx_suggestions" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'entity_links' THEN
          UPDATE public."entity_links" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."source_entity_id" = ANY(changed_ids)) OR (c."target_entity_id" = ANY(changed_ids));
      ELSIF child_name = 'entity_version_ai_summaries' THEN
          UPDATE public."entity_version_ai_summaries" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'entity_versions' THEN
          UPDATE public."entity_versions" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'extracted_content' THEN
          UPDATE public."extracted_content" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'file_chat_threads' THEN
          UPDATE public."file_chat_threads" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'flow_run_steps' THEN
          UPDATE public."flow_run_steps" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."review_task_entity_id" = ANY(changed_ids));
      ELSIF child_name = 'folio_collab_contributions' THEN
          UPDATE public."folio_collab_contributions" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'folio_collab_publications' THEN
          UPDATE public."folio_collab_publications" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'folio_collab_rooms' THEN
          UPDATE public."folio_collab_rooms" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'legal_list_fact_details' THEN
          UPDATE public."legal_list_fact_details" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."item_entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'legal_list_generation_candidate_sources' THEN
          UPDATE public."legal_list_generation_candidate_sources" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."source_entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'legal_list_generation_candidates' THEN
          UPDATE public."legal_list_generation_candidates" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."accepted_entity_id" = ANY(changed_ids));
      ELSIF child_name = 'legal_list_generation_sources' THEN
          UPDATE public."legal_list_generation_sources" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."source_entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'legal_list_item_comments' THEN
          UPDATE public."legal_list_item_comments" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."item_entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'legal_list_item_reviews' THEN
          UPDATE public."legal_list_item_reviews" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."item_entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'legal_list_item_sources' THEN
          UPDATE public."legal_list_item_sources" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."item_entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)) OR (c."source_entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'legal_list_items' THEN
          UPDATE public."legal_list_items" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'legal_list_verification_runs' THEN
          UPDATE public."legal_list_verification_runs" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'office_file_evidence' THEN
          UPDATE public."office_file_evidence" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'pdf_signing_sessions' THEN
          UPDATE public."pdf_signing_sessions" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'report_exports' THEN
          UPDATE public."report_exports" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."result_entity_id" = ANY(changed_ids));
      ELSIF child_name = 'search_document_preview_passages' THEN
          UPDATE public."search_document_preview_passages" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids));
      ELSIF child_name = 'search_documents' THEN
          UPDATE public."search_documents" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids));
      ELSIF child_name = 'task_assignees' THEN
          UPDATE public."task_assignees" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids));
      ELSIF child_name = 'work_obligation_events' THEN
          UPDATE public."work_obligation_events" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."obligation_entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'work_obligations' THEN
          UPDATE public."work_obligations" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSE
        RAISE EXCEPTION 'Unknown entity feature child %', child_name USING ERRCODE = 'XX000';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'entity_versions' THEN
    IF TG_OP = 'UPDATE' THEN
      WITH changed AS MATERIALIZED (
        SELECT o.id AS old_id, n.id AS new_id
        FROM entity_feature_old_rows o FULL JOIN entity_feature_new_rows n USING (id)
        WHERE ROW(o."id", o."entity_feature_gate", o."workspace_id") IS DISTINCT FROM ROW(n."id", n."entity_feature_gate", n."workspace_id"))
      SELECT ARRAY(SELECT old_id FROM changed WHERE old_id IS NOT NULL
          UNION SELECT new_id FROM changed WHERE new_id IS NOT NULL),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o
          UNION SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT ARRAY(SELECT id FROM entity_feature_old_rows),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o)
        INTO changed_ids, changed_workspace_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM entity_feature_new_rows),
        ARRAY(SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    END IF;
    IF cardinality(changed_ids) = 0 THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Entity feature propagation requires a current snapshot'
        USING ERRCODE = '40001';
    END IF;
    SELECT ARRAY(SELECT candidates.child_name FROM (
        SELECT 'cell_metadata'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."cell_metadata" c WHERE (c."entity_version_id" = ANY(changed_ids)))
        UNION ALL
        SELECT 'desktop_edit_sessions'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."desktop_edit_sessions" c WHERE (c."base_version_id" = ANY(changed_ids)) OR (c."finalized_version_id" = ANY(changed_ids)))
        UNION ALL
        SELECT 'document_processing_runs'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."document_processing_runs" c WHERE (c."entity_version_id" = ANY(changed_ids)))
        UNION ALL
        SELECT 'document_review_parties'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."document_review_parties" c WHERE (c."entity_version_id" = ANY(changed_ids)))
        UNION ALL
        SELECT 'entity_version_ai_summaries'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."entity_version_ai_summaries" c WHERE (c."entity_version_id" = ANY(changed_ids)))
        UNION ALL
        SELECT 'extracted_content'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."extracted_content" c WHERE (c."source_entity_version_id" = ANY(changed_ids)))
        UNION ALL
        SELECT 'fields'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."fields" c WHERE (c."entity_version_id" = ANY(changed_ids)))
        UNION ALL
        SELECT 'folio_collab_contributions'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."folio_collab_contributions" c WHERE (c."since_version_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'folio_collab_publications'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."folio_collab_publications" c WHERE (c."entity_version_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'folio_collab_rooms'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."folio_collab_rooms" c WHERE (c."base_version_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)) OR (c."source_version_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'legal_list_generation_candidate_sources'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_generation_candidate_sources" c WHERE (c."source_entity_version_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'legal_list_generation_sources'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_generation_sources" c WHERE (c."source_entity_version_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'legal_list_item_sources'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_item_sources" c WHERE (c."source_entity_version_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'office_file_evidence'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."office_file_evidence" c WHERE (c."entity_version_id" = ANY(changed_ids)))
        UNION ALL
        SELECT 'pdf_signing_sessions'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."pdf_signing_sessions" c WHERE (c."base_version_id" = ANY(changed_ids)) OR (c."finalized_version_id" = ANY(changed_ids)))) candidates ORDER BY candidates.child_name)
      INTO matching_children;
    FOREACH child_name IN ARRAY matching_children LOOP
      IF child_name = 'cell_metadata' THEN
          UPDATE public."cell_metadata" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_version_id" = ANY(changed_ids));
      ELSIF child_name = 'desktop_edit_sessions' THEN
          UPDATE public."desktop_edit_sessions" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."base_version_id" = ANY(changed_ids)) OR (c."finalized_version_id" = ANY(changed_ids));
      ELSIF child_name = 'document_processing_runs' THEN
          UPDATE public."document_processing_runs" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_version_id" = ANY(changed_ids));
      ELSIF child_name = 'document_review_parties' THEN
          UPDATE public."document_review_parties" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_version_id" = ANY(changed_ids));
      ELSIF child_name = 'entity_version_ai_summaries' THEN
          UPDATE public."entity_version_ai_summaries" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_version_id" = ANY(changed_ids));
      ELSIF child_name = 'extracted_content' THEN
          UPDATE public."extracted_content" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."source_entity_version_id" = ANY(changed_ids));
      ELSIF child_name = 'fields' THEN
          UPDATE public."fields" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_version_id" = ANY(changed_ids));
      ELSIF child_name = 'folio_collab_contributions' THEN
          UPDATE public."folio_collab_contributions" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."since_version_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'folio_collab_publications' THEN
          UPDATE public."folio_collab_publications" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_version_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'folio_collab_rooms' THEN
          UPDATE public."folio_collab_rooms" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."base_version_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)) OR (c."source_version_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'legal_list_generation_candidate_sources' THEN
          UPDATE public."legal_list_generation_candidate_sources" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."source_entity_version_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'legal_list_generation_sources' THEN
          UPDATE public."legal_list_generation_sources" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."source_entity_version_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'legal_list_item_sources' THEN
          UPDATE public."legal_list_item_sources" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."source_entity_version_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'office_file_evidence' THEN
          UPDATE public."office_file_evidence" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_version_id" = ANY(changed_ids));
      ELSIF child_name = 'pdf_signing_sessions' THEN
          UPDATE public."pdf_signing_sessions" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."base_version_id" = ANY(changed_ids)) OR (c."finalized_version_id" = ANY(changed_ids));
      ELSE
        RAISE EXCEPTION 'Unknown entity feature child %', child_name USING ERRCODE = 'XX000';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'correspondence' THEN
    IF TG_OP = 'UPDATE' THEN
      WITH changed AS MATERIALIZED (
        SELECT o.id AS old_id, n.id AS new_id
        FROM entity_feature_old_rows o FULL JOIN entity_feature_new_rows n USING (id)
        WHERE ROW(o."id", o."entity_feature_gate", o."workspace_id", o."organization_id") IS DISTINCT FROM ROW(n."id", n."entity_feature_gate", n."workspace_id", n."organization_id"))
      SELECT ARRAY(SELECT old_id FROM changed WHERE old_id IS NOT NULL
          UNION SELECT new_id FROM changed WHERE new_id IS NOT NULL),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o
          UNION SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT ARRAY(SELECT id FROM entity_feature_old_rows),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o)
        INTO changed_ids, changed_workspace_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM entity_feature_new_rows),
        ARRAY(SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    END IF;
    IF cardinality(changed_ids) = 0 THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Entity feature propagation requires a current snapshot'
        USING ERRCODE = '40001';
    END IF;
    SELECT ARRAY(SELECT candidates.child_name FROM (
        SELECT 'correspondence_attachments'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."correspondence_attachments" c WHERE (c."correspondence_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'correspondence_filers'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."correspondence_filers" c WHERE (c."correspondence_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))) candidates ORDER BY candidates.child_name)
      INTO matching_children;
    FOREACH child_name IN ARRAY matching_children LOOP
      IF child_name = 'correspondence_attachments' THEN
          UPDATE public."correspondence_attachments" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."correspondence_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'correspondence_filers' THEN
          UPDATE public."correspondence_filers" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."correspondence_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSE
        RAISE EXCEPTION 'Unknown entity feature child %', child_name USING ERRCODE = 'XX000';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'desktop_edit_sessions' THEN
    IF TG_OP = 'UPDATE' THEN
      WITH changed AS MATERIALIZED (
        SELECT o.id AS old_id, n.id AS new_id
        FROM entity_feature_old_rows o FULL JOIN entity_feature_new_rows n USING (id)
        WHERE ROW(o."id", o."entity_feature_gate", o."workspace_id", o."entity_feature_workspace_ids") IS DISTINCT FROM ROW(n."id", n."entity_feature_gate", n."workspace_id", n."entity_feature_workspace_ids"))
      SELECT ARRAY(SELECT old_id FROM changed WHERE old_id IS NOT NULL
          UNION SELECT new_id FROM changed WHERE new_id IS NOT NULL),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o
          UNION SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT ARRAY(SELECT id FROM entity_feature_old_rows),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o)
        INTO changed_ids, changed_workspace_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM entity_feature_new_rows),
        ARRAY(SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    END IF;
    IF cardinality(changed_ids) = 0 THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Entity feature propagation requires a current snapshot'
        USING ERRCODE = '40001';
    END IF;
    SELECT ARRAY(SELECT candidates.child_name FROM (
        SELECT 'desktop_edit_handoffs'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."desktop_edit_handoffs" c WHERE (c."desktop_session_id" = ANY(changed_ids)))) candidates ORDER BY candidates.child_name)
      INTO matching_children;
    FOREACH child_name IN ARRAY matching_children LOOP
      IF child_name = 'desktop_edit_handoffs' THEN
          UPDATE public."desktop_edit_handoffs" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."desktop_session_id" = ANY(changed_ids));
      ELSE
        RAISE EXCEPTION 'Unknown entity feature child %', child_name USING ERRCODE = 'XX000';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'fields' THEN
    IF TG_OP = 'UPDATE' THEN
      WITH changed AS MATERIALIZED (
        SELECT o.id AS old_id, n.id AS new_id
        FROM entity_feature_old_rows o FULL JOIN entity_feature_new_rows n USING (id)
        WHERE ROW(o."id", o."entity_feature_gate", o."workspace_id", o."entity_feature_workspace_ids") IS DISTINCT FROM ROW(n."id", n."entity_feature_gate", n."workspace_id", n."entity_feature_workspace_ids"))
      SELECT ARRAY(SELECT old_id FROM changed WHERE old_id IS NOT NULL
          UNION SELECT new_id FROM changed WHERE new_id IS NOT NULL),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o
          UNION SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT ARRAY(SELECT id FROM entity_feature_old_rows),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o)
        INTO changed_ids, changed_workspace_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM entity_feature_new_rows),
        ARRAY(SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    END IF;
    IF cardinality(changed_ids) = 0 THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Entity feature propagation requires a current snapshot'
        USING ERRCODE = '40001';
    END IF;
    SELECT ARRAY(SELECT candidates.child_name FROM (
        SELECT 'document_processing_runs'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."document_processing_runs" c WHERE (c."field_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'extracted_content'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."extracted_content" c WHERE (c."source_field_id" = ANY(changed_ids)))
        UNION ALL
        SELECT 'file_chat_threads'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."file_chat_threads" c WHERE (c."field_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'justifications'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."justifications" c WHERE (c."field_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'office_file_evidence'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."office_file_evidence" c WHERE (c."field_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'report_exports'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."report_exports" c WHERE (c."result_field_id" = ANY(changed_ids)))) candidates ORDER BY candidates.child_name)
      INTO matching_children;
    FOREACH child_name IN ARRAY matching_children LOOP
      IF child_name = 'document_processing_runs' THEN
          UPDATE public."document_processing_runs" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."field_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'extracted_content' THEN
          UPDATE public."extracted_content" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."source_field_id" = ANY(changed_ids));
      ELSIF child_name = 'file_chat_threads' THEN
          UPDATE public."file_chat_threads" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."field_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'justifications' THEN
          UPDATE public."justifications" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."field_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'office_file_evidence' THEN
          UPDATE public."office_file_evidence" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."field_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'report_exports' THEN
          UPDATE public."report_exports" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."result_field_id" = ANY(changed_ids));
      ELSE
        RAISE EXCEPTION 'Unknown entity feature child %', child_name USING ERRCODE = 'XX000';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'document_translation_runs' THEN
    IF TG_OP = 'UPDATE' THEN
      WITH changed AS MATERIALIZED (
        SELECT o.id AS old_id, n.id AS new_id
        FROM entity_feature_old_rows o FULL JOIN entity_feature_new_rows n USING (id)
        WHERE ROW(o."id", o."entity_feature_gate", o."workspace_id", o."organization_id", o."entity_feature_workspace_ids") IS DISTINCT FROM ROW(n."id", n."entity_feature_gate", n."workspace_id", n."organization_id", n."entity_feature_workspace_ids"))
      SELECT ARRAY(SELECT old_id FROM changed WHERE old_id IS NOT NULL
          UNION SELECT new_id FROM changed WHERE new_id IS NOT NULL),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o
          UNION SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT ARRAY(SELECT id FROM entity_feature_old_rows),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o)
        INTO changed_ids, changed_workspace_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM entity_feature_new_rows),
        ARRAY(SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    END IF;
    IF cardinality(changed_ids) = 0 THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Entity feature propagation requires a current snapshot'
        USING ERRCODE = '40001';
    END IF;
    SELECT ARRAY(SELECT candidates.child_name FROM (
        SELECT 'document_translation_units'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."document_translation_units" c WHERE (c."run_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))) candidates ORDER BY candidates.child_name)
      INTO matching_children;
    FOREACH child_name IN ARRAY matching_children LOOP
      IF child_name = 'document_translation_units' THEN
          UPDATE public."document_translation_units" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."run_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSE
        RAISE EXCEPTION 'Unknown entity feature child %', child_name USING ERRCODE = 'XX000';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'folio_collab_rooms' THEN
    IF TG_OP = 'UPDATE' THEN
      WITH changed AS MATERIALIZED (
        SELECT o.id AS old_id, n.id AS new_id
        FROM entity_feature_old_rows o FULL JOIN entity_feature_new_rows n USING (id)
        WHERE ROW(o."id", o."entity_feature_gate", o."workspace_id") IS DISTINCT FROM ROW(n."id", n."entity_feature_gate", n."workspace_id"))
      SELECT ARRAY(SELECT old_id FROM changed WHERE old_id IS NOT NULL
          UNION SELECT new_id FROM changed WHERE new_id IS NOT NULL),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o
          UNION SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT ARRAY(SELECT id FROM entity_feature_old_rows),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o)
        INTO changed_ids, changed_workspace_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM entity_feature_new_rows),
        ARRAY(SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    END IF;
    IF cardinality(changed_ids) = 0 THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Entity feature propagation requires a current snapshot'
        USING ERRCODE = '40001';
    END IF;
    SELECT ARRAY(SELECT candidates.child_name FROM (
        SELECT 'folio_collab_contributions'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."folio_collab_contributions" c WHERE (c."room_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'folio_collab_publications'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."folio_collab_publications" c WHERE (c."room_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'folio_collab_room_tokens'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."folio_collab_room_tokens" c WHERE (c."room_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))) candidates ORDER BY candidates.child_name)
      INTO matching_children;
    FOREACH child_name IN ARRAY matching_children LOOP
      IF child_name = 'folio_collab_contributions' THEN
          UPDATE public."folio_collab_contributions" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."room_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'folio_collab_publications' THEN
          UPDATE public."folio_collab_publications" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."room_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'folio_collab_room_tokens' THEN
          UPDATE public."folio_collab_room_tokens" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."room_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSE
        RAISE EXCEPTION 'Unknown entity feature child %', child_name USING ERRCODE = 'XX000';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'legal_list_verification_runs' THEN
    IF TG_OP = 'UPDATE' THEN
      WITH changed AS MATERIALIZED (
        SELECT o.id AS old_id, n.id AS new_id
        FROM entity_feature_old_rows o FULL JOIN entity_feature_new_rows n USING (id)
        WHERE ROW(o."id", o."entity_feature_gate", o."workspace_id", o."organization_id") IS DISTINCT FROM ROW(n."id", n."entity_feature_gate", n."workspace_id", n."organization_id"))
      SELECT ARRAY(SELECT old_id FROM changed WHERE old_id IS NOT NULL
          UNION SELECT new_id FROM changed WHERE new_id IS NOT NULL),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o
          UNION SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT ARRAY(SELECT id FROM entity_feature_old_rows),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o)
        INTO changed_ids, changed_workspace_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM entity_feature_new_rows),
        ARRAY(SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    END IF;
    IF cardinality(changed_ids) = 0 THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Entity feature propagation requires a current snapshot'
        USING ERRCODE = '40001';
    END IF;
    SELECT ARRAY(SELECT candidates.child_name FROM (
        SELECT 'legal_list_claims'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_claims" c WHERE (c."run_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'legal_list_verification_blocks'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_verification_blocks" c WHERE (c."run_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))
        UNION ALL
        SELECT 'legal_list_verification_read_receipts'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_verification_read_receipts" c WHERE (c."run_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))) candidates ORDER BY candidates.child_name)
      INTO matching_children;
    FOREACH child_name IN ARRAY matching_children LOOP
      IF child_name = 'legal_list_claims' THEN
          UPDATE public."legal_list_claims" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."run_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'legal_list_verification_blocks' THEN
          UPDATE public."legal_list_verification_blocks" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."run_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSIF child_name = 'legal_list_verification_read_receipts' THEN
          UPDATE public."legal_list_verification_read_receipts" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."run_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSE
        RAISE EXCEPTION 'Unknown entity feature child %', child_name USING ERRCODE = 'XX000';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'legal_list_claims' THEN
    IF TG_OP = 'UPDATE' THEN
      WITH changed AS MATERIALIZED (
        SELECT o.id AS old_id, n.id AS new_id
        FROM entity_feature_old_rows o FULL JOIN entity_feature_new_rows n USING (id)
        WHERE ROW(o."id", o."entity_feature_gate", o."workspace_id", o."entity_feature_organization_ids") IS DISTINCT FROM ROW(n."id", n."entity_feature_gate", n."workspace_id", n."entity_feature_organization_ids"))
      SELECT ARRAY(SELECT old_id FROM changed WHERE old_id IS NOT NULL
          UNION SELECT new_id FROM changed WHERE new_id IS NOT NULL),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o
          UNION SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT ARRAY(SELECT id FROM entity_feature_old_rows),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o)
        INTO changed_ids, changed_workspace_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM entity_feature_new_rows),
        ARRAY(SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    END IF;
    IF cardinality(changed_ids) = 0 THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Entity feature propagation requires a current snapshot'
        USING ERRCODE = '40001';
    END IF;
    SELECT ARRAY(SELECT candidates.child_name FROM (
        SELECT 'legal_list_claim_review_events'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_claim_review_events" c WHERE (c."claim_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))) candidates ORDER BY candidates.child_name)
      INTO matching_children;
    FOREACH child_name IN ARRAY matching_children LOOP
      IF child_name = 'legal_list_claim_review_events' THEN
          UPDATE public."legal_list_claim_review_events" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."claim_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSE
        RAISE EXCEPTION 'Unknown entity feature child %', child_name USING ERRCODE = 'XX000';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'legal_list_generation_candidates' THEN
    IF TG_OP = 'UPDATE' THEN
      WITH changed AS MATERIALIZED (
        SELECT o.id AS old_id, n.id AS new_id
        FROM entity_feature_old_rows o FULL JOIN entity_feature_new_rows n USING (id)
        WHERE ROW(o."id", o."entity_feature_gate", o."workspace_id", o."entity_feature_workspace_ids") IS DISTINCT FROM ROW(n."id", n."entity_feature_gate", n."workspace_id", n."entity_feature_workspace_ids"))
      SELECT ARRAY(SELECT old_id FROM changed WHERE old_id IS NOT NULL
          UNION SELECT new_id FROM changed WHERE new_id IS NOT NULL),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o
          UNION SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT ARRAY(SELECT id FROM entity_feature_old_rows),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o)
        INTO changed_ids, changed_workspace_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM entity_feature_new_rows),
        ARRAY(SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    END IF;
    IF cardinality(changed_ids) = 0 THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Entity feature propagation requires a current snapshot'
        USING ERRCODE = '40001';
    END IF;
    SELECT ARRAY(SELECT candidates.child_name FROM (
        SELECT 'legal_list_generation_candidate_sources'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_generation_candidate_sources" c WHERE (c."candidate_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids)))) candidates ORDER BY candidates.child_name)
      INTO matching_children;
    FOREACH child_name IN ARRAY matching_children LOOP
      IF child_name = 'legal_list_generation_candidate_sources' THEN
          UPDATE public."legal_list_generation_candidate_sources" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."candidate_id" = ANY(changed_ids) AND c.workspace_id = ANY(changed_workspace_ids));
      ELSE
        RAISE EXCEPTION 'Unknown entity feature child %', child_name USING ERRCODE = 'XX000';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.entity_feature_gate_propagate() FROM PUBLIC;
--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - Dedicated-role trigger routines derive stored visibility and lock trusted graph parents; fixed search_path and no PUBLIC execute.
CREATE OR REPLACE FUNCTION public.entity_feature_gate_repair_missing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog SET row_security = on AS $function$
DECLARE
  descriptor jsonb;
  predicate text;
  gate jsonb;
BEGIN
  IF NEW.entity_feature_gate <> 'missing' THEN RETURN NULL; END IF;
  -- Immediate FK checks run before this AFTER trigger. A system writer may
  -- have waited there for a parent that its BEFORE trigger could not see.
  gate := public.entity_feature_gate_value(TG_TABLE_NAME, to_jsonb(NEW));
  IF gate->>'state' = 'missing' THEN RETURN NULL; END IF;
  descriptor := public.entity_feature_gate_graph()->TG_TABLE_NAME;
  SELECT string_agg(format('t.%I = k.%I', value, value), ' AND ')
    INTO predicate FROM jsonb_array_elements_text(descriptor->'primaryKey');
  EXECUTE format('UPDATE public.%I t SET entity_feature_gate = t.entity_feature_gate
    FROM jsonb_populate_record(NULL::public.%I, $1) k WHERE %s',
    TG_TABLE_NAME, TG_TABLE_NAME, predicate) USING to_jsonb(NEW);
  RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.entity_feature_gate_repair_missing() FROM PUBLIC;
--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - Dedicated-role trigger routines derive stored visibility and lock trusted graph parents; fixed search_path and no PUBLIC execute.
CREATE OR REPLACE FUNCTION public.entity_feature_gate_backfill(table_name text, batch_cursor text, batch_size integer)
RETURNS TABLE(cursor text, count integer, pending boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET row_security = on AS $function$
DECLARE
  descriptor jsonb := public.entity_feature_gate_graph()->table_name;
  key_columns text;
  identity text;
  join_columns text;
  descending_columns text;
BEGIN
  IF descriptor IS NULL OR batch_size IS NULL OR batch_size < 0 OR batch_size > 2048 THEN
    RAISE EXCEPTION 'Invalid entity feature backfill batch';
  END IF;
  SELECT string_agg(format('%I', value), ', ' ORDER BY ordinal),
    string_agg(format('%L, b.%I', value, value), ', ' ORDER BY ordinal),
    string_agg(format('t.%I = b.%I', value, value), ' AND ' ORDER BY ordinal),
    string_agg(format('b.%I DESC', value), ', ' ORDER BY ordinal)
  INTO key_columns, identity, join_columns, descending_columns
  FROM jsonb_array_elements_text(descriptor->'primaryKey') WITH ORDINALITY AS keys(value, ordinal);
  RETURN QUERY EXECUTE format('WITH batch AS MATERIALIZED (
      SELECT %1$s FROM public.%2$I WHERE entity_feature_gate = ''pending''
        AND ($1::text IS NULL OR (%1$s) > (SELECT %1$s FROM jsonb_populate_record(NULL::public.%2$I, $1::jsonb)))
      ORDER BY %1$s LIMIT $2 FOR UPDATE
    ), updated AS (
      UPDATE public.%2$I t SET entity_feature_gate = t.entity_feature_gate
      FROM batch b WHERE %3$s RETURNING 1
    ) SELECT (SELECT jsonb_build_object(%4$s)::text FROM batch b ORDER BY %5$s LIMIT 1),
      (SELECT count(*)::integer FROM updated),
      CASE WHEN (SELECT count(*) FROM updated) > 0 THEN true
        ELSE EXISTS (SELECT 1 FROM public.%2$I WHERE entity_feature_gate = ''pending'' LIMIT 1) END',
    key_columns, table_name, join_columns, identity, descending_columns)
    USING batch_cursor, batch_size;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.entity_feature_gate_backfill(text, text, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.entity_feature_gate_backfill(text, text, integer) TO SESSION_USER;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.entity_feature_gate_write(), public.entity_feature_gate_propagate(), public.entity_feature_gate_repair_missing() TO SESSION_USER;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM stella_entity_gate;
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."entities";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."entities" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."anonymization_allowlist_entries";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."anonymization_allowlist_entries" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."entity_versions";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."entity_versions" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."cell_metadata";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."cell_metadata" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."correspondence";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."correspondence" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."correspondence_attachments";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."correspondence_attachments" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."correspondence_filers";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."correspondence_filers" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."desktop_edit_sessions";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."desktop_edit_sessions" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."desktop_edit_handoffs";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."desktop_edit_handoffs" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."fields";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."fields" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."document_processing_runs";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."document_processing_runs" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."document_review_parties";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."document_review_parties" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."document_review_reference_passages";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."document_review_reference_passages" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."document_translation_runs";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."document_translation_runs" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."document_translation_units";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."document_translation_units" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."docx_suggestions";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."docx_suggestions" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."entity_links";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."entity_links" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."entity_version_ai_summaries";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."entity_version_ai_summaries" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."extracted_content";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."extracted_content" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."file_chat_threads";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."file_chat_threads" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."flow_run_steps";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."flow_run_steps" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."folio_collab_rooms";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."folio_collab_rooms" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."folio_collab_contributions";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."folio_collab_contributions" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."folio_collab_publications";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."folio_collab_publications" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."folio_collab_room_tokens";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."folio_collab_room_tokens" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."justifications";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."justifications" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."legal_list_verification_runs";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."legal_list_verification_runs" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."legal_list_claims";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."legal_list_claims" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."legal_list_claim_review_events";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."legal_list_claim_review_events" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."legal_list_fact_details";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."legal_list_fact_details" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."legal_list_generation_candidates";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."legal_list_generation_candidates" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."legal_list_generation_candidate_sources";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."legal_list_generation_candidate_sources" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."legal_list_generation_sources";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."legal_list_generation_sources" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."legal_list_item_comments";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."legal_list_item_comments" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."legal_list_item_reviews";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."legal_list_item_reviews" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."legal_list_item_sources";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."legal_list_item_sources" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."legal_list_items";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."legal_list_items" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."legal_list_verification_blocks";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."legal_list_verification_blocks" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."legal_list_verification_read_receipts";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."legal_list_verification_read_receipts" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."office_file_evidence";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."office_file_evidence" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."pdf_signing_sessions";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."pdf_signing_sessions" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."report_exports";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."report_exports" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."search_document_preview_passages";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."search_document_preview_passages" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."search_documents";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."search_documents" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."task_assignees";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."task_assignees" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."work_obligation_events";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."work_obligation_events" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate trigger is idempotent; the original restrictive policy remains active.
DROP TRIGGER IF EXISTS entity_feature_gate_write ON public."work_obligations";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."work_obligations" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."anonymization_allowlist_entries";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."anonymization_allowlist_entries" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."entity_versions";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."entity_versions" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."cell_metadata";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."cell_metadata" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."correspondence";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."correspondence" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."correspondence_attachments";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."correspondence_attachments" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."correspondence_filers";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."correspondence_filers" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."desktop_edit_sessions";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."desktop_edit_sessions" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."desktop_edit_handoffs";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."desktop_edit_handoffs" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."fields";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."fields" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."document_processing_runs";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."document_processing_runs" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."document_review_parties";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."document_review_parties" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."document_review_reference_passages";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."document_review_reference_passages" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."document_translation_runs";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."document_translation_runs" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."document_translation_units";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."document_translation_units" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."docx_suggestions";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."docx_suggestions" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."entity_links";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."entity_links" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."entity_version_ai_summaries";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."entity_version_ai_summaries" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."extracted_content";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."extracted_content" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."file_chat_threads";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."file_chat_threads" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."flow_run_steps";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."flow_run_steps" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."folio_collab_rooms";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."folio_collab_rooms" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."folio_collab_contributions";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."folio_collab_contributions" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."folio_collab_publications";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."folio_collab_publications" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."folio_collab_room_tokens";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."folio_collab_room_tokens" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."justifications";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."justifications" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."legal_list_verification_runs";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."legal_list_verification_runs" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."legal_list_claims";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."legal_list_claims" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."legal_list_claim_review_events";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."legal_list_claim_review_events" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."legal_list_fact_details";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."legal_list_fact_details" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."legal_list_generation_candidates";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."legal_list_generation_candidates" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."legal_list_generation_candidate_sources";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."legal_list_generation_candidate_sources" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."legal_list_generation_sources";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."legal_list_generation_sources" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."legal_list_item_comments";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."legal_list_item_comments" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."legal_list_item_reviews";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."legal_list_item_reviews" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."legal_list_item_sources";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."legal_list_item_sources" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."legal_list_items";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."legal_list_items" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."legal_list_verification_blocks";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."legal_list_verification_blocks" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."legal_list_verification_read_receipts";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."legal_list_verification_read_receipts" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."office_file_evidence";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."office_file_evidence" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."pdf_signing_sessions";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."pdf_signing_sessions" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."report_exports";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."report_exports" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."search_document_preview_passages";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."search_document_preview_passages" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."search_documents";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."search_documents" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."task_assignees";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."task_assignees" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."work_obligation_events";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."work_obligation_events" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - The dedicated-role AFTER trigger refreshes a gate after an immediate FK wait.
DROP TRIGGER IF EXISTS entity_feature_gate_repair_missing ON public."work_obligations";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_repair_missing AFTER INSERT OR UPDATE ON public."work_obligations" FOR EACH ROW WHEN (NEW.entity_feature_gate = 'missing') EXECUTE FUNCTION public.entity_feature_gate_repair_missing();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_insert ON public."entities";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_insert AFTER INSERT ON public."entities" REFERENCING NEW TABLE AS entity_feature_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_update ON public."entities";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_update AFTER UPDATE ON public."entities" REFERENCING OLD TABLE AS entity_feature_old_rows NEW TABLE AS entity_feature_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_delete ON public."entities";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_delete AFTER DELETE ON public."entities" REFERENCING OLD TABLE AS entity_feature_old_rows  FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_insert ON public."entity_versions";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_insert AFTER INSERT ON public."entity_versions" REFERENCING NEW TABLE AS entity_feature_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_update ON public."entity_versions";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_update AFTER UPDATE ON public."entity_versions" REFERENCING OLD TABLE AS entity_feature_old_rows NEW TABLE AS entity_feature_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_delete ON public."entity_versions";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_delete AFTER DELETE ON public."entity_versions" REFERENCING OLD TABLE AS entity_feature_old_rows  FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_insert ON public."correspondence";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_insert AFTER INSERT ON public."correspondence" REFERENCING NEW TABLE AS entity_feature_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_update ON public."correspondence";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_update AFTER UPDATE ON public."correspondence" REFERENCING OLD TABLE AS entity_feature_old_rows NEW TABLE AS entity_feature_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_delete ON public."correspondence";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_delete AFTER DELETE ON public."correspondence" REFERENCING OLD TABLE AS entity_feature_old_rows  FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_insert ON public."desktop_edit_sessions";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_insert AFTER INSERT ON public."desktop_edit_sessions" REFERENCING NEW TABLE AS entity_feature_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_update ON public."desktop_edit_sessions";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_update AFTER UPDATE ON public."desktop_edit_sessions" REFERENCING OLD TABLE AS entity_feature_old_rows NEW TABLE AS entity_feature_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_delete ON public."desktop_edit_sessions";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_delete AFTER DELETE ON public."desktop_edit_sessions" REFERENCING OLD TABLE AS entity_feature_old_rows  FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_insert ON public."fields";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_insert AFTER INSERT ON public."fields" REFERENCING NEW TABLE AS entity_feature_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_update ON public."fields";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_update AFTER UPDATE ON public."fields" REFERENCING OLD TABLE AS entity_feature_old_rows NEW TABLE AS entity_feature_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_delete ON public."fields";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_delete AFTER DELETE ON public."fields" REFERENCING OLD TABLE AS entity_feature_old_rows  FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_insert ON public."document_translation_runs";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_insert AFTER INSERT ON public."document_translation_runs" REFERENCING NEW TABLE AS entity_feature_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_update ON public."document_translation_runs";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_update AFTER UPDATE ON public."document_translation_runs" REFERENCING OLD TABLE AS entity_feature_old_rows NEW TABLE AS entity_feature_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_delete ON public."document_translation_runs";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_delete AFTER DELETE ON public."document_translation_runs" REFERENCING OLD TABLE AS entity_feature_old_rows  FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_insert ON public."folio_collab_rooms";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_insert AFTER INSERT ON public."folio_collab_rooms" REFERENCING NEW TABLE AS entity_feature_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_update ON public."folio_collab_rooms";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_update AFTER UPDATE ON public."folio_collab_rooms" REFERENCING OLD TABLE AS entity_feature_old_rows NEW TABLE AS entity_feature_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_delete ON public."folio_collab_rooms";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_delete AFTER DELETE ON public."folio_collab_rooms" REFERENCING OLD TABLE AS entity_feature_old_rows  FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_insert ON public."legal_list_verification_runs";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_insert AFTER INSERT ON public."legal_list_verification_runs" REFERENCING NEW TABLE AS entity_feature_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_update ON public."legal_list_verification_runs";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_update AFTER UPDATE ON public."legal_list_verification_runs" REFERENCING OLD TABLE AS entity_feature_old_rows NEW TABLE AS entity_feature_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_delete ON public."legal_list_verification_runs";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_delete AFTER DELETE ON public."legal_list_verification_runs" REFERENCING OLD TABLE AS entity_feature_old_rows  FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_insert ON public."legal_list_claims";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_insert AFTER INSERT ON public."legal_list_claims" REFERENCING NEW TABLE AS entity_feature_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_update ON public."legal_list_claims";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_update AFTER UPDATE ON public."legal_list_claims" REFERENCING OLD TABLE AS entity_feature_old_rows NEW TABLE AS entity_feature_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_delete ON public."legal_list_claims";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_delete AFTER DELETE ON public."legal_list_claims" REFERENCING OLD TABLE AS entity_feature_old_rows  FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_insert ON public."legal_list_generation_candidates";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_insert AFTER INSERT ON public."legal_list_generation_candidates" REFERENCING NEW TABLE AS entity_feature_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_update ON public."legal_list_generation_candidates";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_update AFTER UPDATE ON public."legal_list_generation_candidates" REFERENCING OLD TABLE AS entity_feature_old_rows NEW TABLE AS entity_feature_new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreating the derived-gate propagation trigger preserves the original policy during rollout.
DROP TRIGGER IF EXISTS entity_feature_gate_delete ON public."legal_list_generation_candidates";
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_delete AFTER DELETE ON public."legal_list_generation_candidates" REFERENCING OLD TABLE AS entity_feature_old_rows  FOR EACH STATEMENT EXECUTE FUNCTION public.entity_feature_gate_propagate();
--> statement-breakpoint
SET LOCAL ROLE stella_entity_gate;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.entity_feature_gate_write(), public.entity_feature_gate_propagate(), public.entity_feature_gate_repair_missing() FROM SESSION_USER;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
-- stella-migration-safety: reviewed grant-privileges - Disable runtime role switching before commit while retaining administration for retries.
GRANT stella_entity_gate TO CURRENT_USER WITH SET FALSE;
--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."desktop_edit_handoffs_ef_desktop_session_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "desktop_edit_handoffs_ef_desktop_session_id_idx" ON public."desktop_edit_handoffs" ("desktop_session_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."desktop_edit_handoffs_ef_entity_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "desktop_edit_handoffs_ef_entity_id_idx" ON public."desktop_edit_handoffs" ("workspace_id", "entity_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."desktop_edit_sessions_ef_finalized_version_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "desktop_edit_sessions_ef_finalized_version_id_idx" ON public."desktop_edit_sessions" ("finalized_version_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."document_review_parties_ef_entity_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "document_review_parties_ef_entity_id_idx" ON public."document_review_parties" ("workspace_id", "entity_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."document_review_reference_passages_ef_entity_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "document_review_reference_passages_ef_entity_id_idx" ON public."document_review_reference_passages" ("workspace_id", "entity_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."document_translation_runs_ef_entity_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "document_translation_runs_ef_entity_id_idx" ON public."document_translation_runs" ("entity_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."fields_ef_entity_version_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "fields_ef_entity_version_id_idx" ON public."fields" ("entity_version_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."file_chat_threads_ef_field_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "file_chat_threads_ef_field_id_idx" ON public."file_chat_threads" ("workspace_id", "field_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."flow_run_steps_ef_review_task_entity_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "flow_run_steps_ef_review_task_entity_id_idx" ON public."flow_run_steps" ("review_task_entity_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."folio_collab_contributions_ef_entity_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "folio_collab_contributions_ef_entity_id_idx" ON public."folio_collab_contributions" ("workspace_id", "entity_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."folio_collab_contributions_ef_since_version_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "folio_collab_contributions_ef_since_version_id_idx" ON public."folio_collab_contributions" ("workspace_id", "since_version_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."folio_collab_publications_ef_entity_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "folio_collab_publications_ef_entity_id_idx" ON public."folio_collab_publications" ("workspace_id", "entity_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."folio_collab_publications_ef_entity_version_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "folio_collab_publications_ef_entity_version_id_idx" ON public."folio_collab_publications" ("workspace_id", "entity_version_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."folio_collab_rooms_ef_base_version_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "folio_collab_rooms_ef_base_version_id_idx" ON public."folio_collab_rooms" ("workspace_id", "base_version_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."legal_list_claim_review_events_ef_claim_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "legal_list_claim_review_events_ef_claim_id_idx" ON public."legal_list_claim_review_events" ("workspace_id", "claim_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."legal_list_generation_candidate_sources_ef_source_entity_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "legal_list_generation_candidate_sources_ef_source_entity_id_idx" ON public."legal_list_generation_candidate_sources" ("workspace_id", "source_entity_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."legal_list_generation_candidate_sources_ef_source_enti_1530c551";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "legal_list_generation_candidate_sources_ef_source_enti_1530c551" ON public."legal_list_generation_candidate_sources" ("workspace_id", "source_entity_version_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."legal_list_generation_candidates_ef_accepted_entity_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "legal_list_generation_candidates_ef_accepted_entity_id_idx" ON public."legal_list_generation_candidates" ("accepted_entity_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."legal_list_generation_sources_ef_source_entity_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "legal_list_generation_sources_ef_source_entity_id_idx" ON public."legal_list_generation_sources" ("workspace_id", "source_entity_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."legal_list_generation_sources_ef_source_entity_version_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "legal_list_generation_sources_ef_source_entity_version_id_idx" ON public."legal_list_generation_sources" ("workspace_id", "source_entity_version_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."legal_list_item_sources_ef_source_entity_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "legal_list_item_sources_ef_source_entity_id_idx" ON public."legal_list_item_sources" ("workspace_id", "source_entity_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."pdf_signing_sessions_ef_base_version_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "pdf_signing_sessions_ef_base_version_id_idx" ON public."pdf_signing_sessions" ("base_version_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."pdf_signing_sessions_ef_finalized_version_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "pdf_signing_sessions_ef_finalized_version_id_idx" ON public."pdf_signing_sessions" ("finalized_version_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's propagation index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."report_exports_ef_result_entity_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "report_exports_ef_result_entity_id_idx" ON public."report_exports" ("result_entity_id");
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Retry rebuilds only this migration's equality-read index, including interrupted invalid builds.
DROP INDEX CONCURRENTLY IF EXISTS public."entity_versions_id_hash_idx";
--> statement-breakpoint
-- Equality reads still inspect the version's row-local gate and tenant scope.
-- squawk-ignore prefer-robust-stmts -- Retry removes invalid builds before recreating this index.
CREATE INDEX CONCURRENTLY "entity_versions_id_hash_idx" ON public."entity_versions" USING hash ("id");
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - Owner-only atomic cutover checks all backfilled gates; it is not callable by the application role.
CREATE OR REPLACE FUNCTION public.entity_feature_gate_finish() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET row_security = on AS $finish$
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid = c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND c.conname = 'entity_feature_gate_ready_check' AND c.convalidated
      AND public.entity_feature_gate_graph() ? t.relname) <> (SELECT count(*) FROM jsonb_object_keys(public.entity_feature_gate_graph())) THEN
    RAISE EXCEPTION 'Entity feature backfill and validation are incomplete';
  END IF;
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."anonymization_allowlist_entries";
  CREATE POLICY "workspace_entity_feature" ON "public"."anonymization_allowlist_entries" AS RESTRICTIVE FOR ALL TO "stella" USING (("anonymization_allowlist_entries"."entity_feature_gate" = 'open' OR ("anonymization_allowlist_entries"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("anonymization_allowlist_entries"."entity_feature_workspace_ids" = '{}'::uuid[] OR "anonymization_allowlist_entries"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("anonymization_allowlist_entries"."entity_feature_gate" = 'open' OR ("anonymization_allowlist_entries"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("anonymization_allowlist_entries"."entity_feature_workspace_ids" = '{}'::uuid[] OR "anonymization_allowlist_entries"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."cell_metadata";
  CREATE POLICY "workspace_entity_feature" ON "public"."cell_metadata" AS RESTRICTIVE FOR ALL TO "stella" USING (("cell_metadata"."entity_feature_gate" = 'open' OR ("cell_metadata"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("cell_metadata"."entity_feature_workspace_ids" = '{}'::uuid[] OR "cell_metadata"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("cell_metadata"."entity_feature_gate" = 'open' OR ("cell_metadata"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("cell_metadata"."entity_feature_workspace_ids" = '{}'::uuid[] OR "cell_metadata"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."correspondence";
  CREATE POLICY "workspace_entity_feature" ON "public"."correspondence" AS RESTRICTIVE FOR ALL TO "stella" USING (("correspondence"."entity_feature_gate" = 'open' OR ("correspondence"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')))) WITH CHECK (("correspondence"."entity_feature_gate" = 'open' OR ("correspondence"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."correspondence_attachments";
  CREATE POLICY "workspace_entity_feature" ON "public"."correspondence_attachments" AS RESTRICTIVE FOR ALL TO "stella" USING (("correspondence_attachments"."entity_feature_gate" = 'open' OR ("correspondence_attachments"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')))) WITH CHECK (("correspondence_attachments"."entity_feature_gate" = 'open' OR ("correspondence_attachments"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."correspondence_filers";
  CREATE POLICY "workspace_entity_feature" ON "public"."correspondence_filers" AS RESTRICTIVE FOR ALL TO "stella" USING (("correspondence_filers"."entity_feature_gate" = 'open' OR ("correspondence_filers"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')))) WITH CHECK (("correspondence_filers"."entity_feature_gate" = 'open' OR ("correspondence_filers"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."desktop_edit_handoffs";
  CREATE POLICY "workspace_entity_feature" ON "public"."desktop_edit_handoffs" AS RESTRICTIVE FOR ALL TO "stella" USING (("desktop_edit_handoffs"."entity_feature_gate" = 'open' OR ("desktop_edit_handoffs"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("desktop_edit_handoffs"."entity_feature_workspace_ids" = '{}'::uuid[] OR "desktop_edit_handoffs"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("desktop_edit_handoffs"."entity_feature_gate" = 'open' OR ("desktop_edit_handoffs"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("desktop_edit_handoffs"."entity_feature_workspace_ids" = '{}'::uuid[] OR "desktop_edit_handoffs"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."desktop_edit_sessions";
  CREATE POLICY "workspace_entity_feature" ON "public"."desktop_edit_sessions" AS RESTRICTIVE FOR ALL TO "stella" USING (("desktop_edit_sessions"."entity_feature_gate" = 'open' OR ("desktop_edit_sessions"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("desktop_edit_sessions"."entity_feature_workspace_ids" = '{}'::uuid[] OR "desktop_edit_sessions"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("desktop_edit_sessions"."entity_feature_gate" = 'open' OR ("desktop_edit_sessions"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("desktop_edit_sessions"."entity_feature_workspace_ids" = '{}'::uuid[] OR "desktop_edit_sessions"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."document_processing_runs";
  CREATE POLICY "workspace_entity_feature" ON "public"."document_processing_runs" AS RESTRICTIVE FOR ALL TO "stella" USING (("document_processing_runs"."entity_feature_gate" = 'open' OR ("document_processing_runs"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("document_processing_runs"."entity_feature_workspace_ids" = '{}'::uuid[] OR "document_processing_runs"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("document_processing_runs"."entity_feature_gate" = 'open' OR ("document_processing_runs"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("document_processing_runs"."entity_feature_workspace_ids" = '{}'::uuid[] OR "document_processing_runs"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."document_review_parties";
  CREATE POLICY "workspace_entity_feature" ON "public"."document_review_parties" AS RESTRICTIVE FOR ALL TO "stella" USING (("document_review_parties"."entity_feature_gate" = 'open' OR ("document_review_parties"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("document_review_parties"."entity_feature_workspace_ids" = '{}'::uuid[] OR "document_review_parties"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("document_review_parties"."entity_feature_gate" = 'open' OR ("document_review_parties"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("document_review_parties"."entity_feature_workspace_ids" = '{}'::uuid[] OR "document_review_parties"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."document_review_reference_passages";
  CREATE POLICY "workspace_entity_feature" ON "public"."document_review_reference_passages" AS RESTRICTIVE FOR ALL TO "stella" USING (("document_review_reference_passages"."entity_feature_gate" = 'open' OR ("document_review_reference_passages"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')))) WITH CHECK (("document_review_reference_passages"."entity_feature_gate" = 'open' OR ("document_review_reference_passages"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."document_translation_runs";
  CREATE POLICY "workspace_entity_feature" ON "public"."document_translation_runs" AS RESTRICTIVE FOR ALL TO "stella" USING (("document_translation_runs"."entity_feature_gate" = 'open' OR ("document_translation_runs"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("document_translation_runs"."entity_feature_workspace_ids" = '{}'::uuid[] OR "document_translation_runs"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("document_translation_runs"."entity_feature_gate" = 'open' OR ("document_translation_runs"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("document_translation_runs"."entity_feature_workspace_ids" = '{}'::uuid[] OR "document_translation_runs"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."document_translation_units";
  CREATE POLICY "workspace_entity_feature" ON "public"."document_translation_units" AS RESTRICTIVE FOR ALL TO "stella" USING (("document_translation_units"."entity_feature_gate" = 'open' OR ("document_translation_units"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("document_translation_units"."entity_feature_workspace_ids" = '{}'::uuid[] OR "document_translation_units"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("document_translation_units"."entity_feature_gate" = 'open' OR ("document_translation_units"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("document_translation_units"."entity_feature_workspace_ids" = '{}'::uuid[] OR "document_translation_units"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."docx_suggestions";
  CREATE POLICY "workspace_entity_feature" ON "public"."docx_suggestions" AS RESTRICTIVE FOR ALL TO "stella" USING (("docx_suggestions"."entity_feature_gate" = 'open' OR ("docx_suggestions"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')))) WITH CHECK (("docx_suggestions"."entity_feature_gate" = 'open' OR ("docx_suggestions"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."entities";
  CREATE POLICY "workspace_entity_feature" ON "public"."entities" AS RESTRICTIVE FOR ALL TO "stella" USING (((SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists') OR "entities"."list_item_type" IS NULL OR "entities"."list_item_type" = 'task')) WITH CHECK (((SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists') OR "entities"."list_item_type" IS NULL OR "entities"."list_item_type" = 'task'));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."entity_links";
  CREATE POLICY "workspace_entity_feature" ON "public"."entity_links" AS RESTRICTIVE FOR ALL TO "stella" USING (("entity_links"."entity_feature_gate" = 'open' OR ("entity_links"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("entity_links"."entity_feature_workspace_ids" = '{}'::uuid[] OR "entity_links"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("entity_links"."entity_feature_gate" = 'open' OR ("entity_links"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("entity_links"."entity_feature_workspace_ids" = '{}'::uuid[] OR "entity_links"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."entity_version_ai_summaries";
  CREATE POLICY "workspace_entity_feature" ON "public"."entity_version_ai_summaries" AS RESTRICTIVE FOR ALL TO "stella" USING (("entity_version_ai_summaries"."entity_feature_gate" = 'open' OR ("entity_version_ai_summaries"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("entity_version_ai_summaries"."entity_feature_workspace_ids" = '{}'::uuid[] OR "entity_version_ai_summaries"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("entity_version_ai_summaries"."entity_feature_gate" = 'open' OR ("entity_version_ai_summaries"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("entity_version_ai_summaries"."entity_feature_workspace_ids" = '{}'::uuid[] OR "entity_version_ai_summaries"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."entity_versions";
  CREATE POLICY "workspace_entity_feature" ON "public"."entity_versions" AS RESTRICTIVE FOR ALL TO "stella" USING (("entity_versions"."entity_feature_gate" = 'open' OR ("entity_versions"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')))) WITH CHECK (("entity_versions"."entity_feature_gate" = 'open' OR ("entity_versions"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."extracted_content";
  CREATE POLICY "workspace_entity_feature" ON "public"."extracted_content" AS RESTRICTIVE FOR ALL TO "stella" USING (("extracted_content"."entity_feature_gate" = 'open' OR ("extracted_content"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("extracted_content"."entity_feature_workspace_ids" = '{}'::uuid[] OR "extracted_content"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("extracted_content"."entity_feature_gate" = 'open' OR ("extracted_content"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("extracted_content"."entity_feature_workspace_ids" = '{}'::uuid[] OR "extracted_content"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."fields";
  CREATE POLICY "workspace_entity_feature" ON "public"."fields" AS RESTRICTIVE FOR ALL TO "stella" USING (("fields"."entity_feature_gate" = 'open' OR ("fields"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("fields"."entity_feature_workspace_ids" = '{}'::uuid[] OR "fields"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("fields"."entity_feature_gate" = 'open' OR ("fields"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("fields"."entity_feature_workspace_ids" = '{}'::uuid[] OR "fields"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."file_chat_threads";
  CREATE POLICY "workspace_entity_feature" ON "public"."file_chat_threads" AS RESTRICTIVE FOR ALL TO "stella" USING (("file_chat_threads"."entity_feature_gate" = 'open' OR ("file_chat_threads"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("file_chat_threads"."entity_feature_workspace_ids" = '{}'::uuid[] OR "file_chat_threads"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("file_chat_threads"."entity_feature_gate" = 'open' OR ("file_chat_threads"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("file_chat_threads"."entity_feature_workspace_ids" = '{}'::uuid[] OR "file_chat_threads"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."flow_run_steps";
  CREATE POLICY "workspace_entity_feature" ON "public"."flow_run_steps" AS RESTRICTIVE FOR ALL TO "stella" USING (("flow_run_steps"."entity_feature_gate" = 'open' OR ("flow_run_steps"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("flow_run_steps"."entity_feature_workspace_ids" = '{}'::uuid[] OR "flow_run_steps"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("flow_run_steps"."entity_feature_gate" = 'open' OR ("flow_run_steps"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("flow_run_steps"."entity_feature_workspace_ids" = '{}'::uuid[] OR "flow_run_steps"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."folio_collab_contributions";
  CREATE POLICY "workspace_entity_feature" ON "public"."folio_collab_contributions" AS RESTRICTIVE FOR ALL TO "stella" USING (("folio_collab_contributions"."entity_feature_gate" = 'open' OR ("folio_collab_contributions"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')))) WITH CHECK (("folio_collab_contributions"."entity_feature_gate" = 'open' OR ("folio_collab_contributions"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."folio_collab_publications";
  CREATE POLICY "workspace_entity_feature" ON "public"."folio_collab_publications" AS RESTRICTIVE FOR ALL TO "stella" USING (("folio_collab_publications"."entity_feature_gate" = 'open' OR ("folio_collab_publications"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')))) WITH CHECK (("folio_collab_publications"."entity_feature_gate" = 'open' OR ("folio_collab_publications"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."folio_collab_room_tokens";
  CREATE POLICY "workspace_entity_feature" ON "public"."folio_collab_room_tokens" AS RESTRICTIVE FOR ALL TO "stella" USING (("folio_collab_room_tokens"."entity_feature_gate" = 'open' OR ("folio_collab_room_tokens"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')))) WITH CHECK (("folio_collab_room_tokens"."entity_feature_gate" = 'open' OR ("folio_collab_room_tokens"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."folio_collab_rooms";
  CREATE POLICY "workspace_entity_feature" ON "public"."folio_collab_rooms" AS RESTRICTIVE FOR ALL TO "stella" USING (("folio_collab_rooms"."entity_feature_gate" = 'open' OR ("folio_collab_rooms"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')))) WITH CHECK (("folio_collab_rooms"."entity_feature_gate" = 'open' OR ("folio_collab_rooms"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."justifications";
  CREATE POLICY "workspace_entity_feature" ON "public"."justifications" AS RESTRICTIVE FOR ALL TO "stella" USING (("justifications"."entity_feature_gate" = 'open' OR ("justifications"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("justifications"."entity_feature_workspace_ids" = '{}'::uuid[] OR "justifications"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("justifications"."entity_feature_gate" = 'open' OR ("justifications"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("justifications"."entity_feature_workspace_ids" = '{}'::uuid[] OR "justifications"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_claim_review_events";
  CREATE POLICY "workspace_entity_feature" ON "public"."legal_list_claim_review_events" AS RESTRICTIVE FOR ALL TO "stella" USING (("legal_list_claim_review_events"."entity_feature_gate" = 'open' OR ("legal_list_claim_review_events"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("legal_list_claim_review_events"."entity_feature_organization_ids" = '{}'::text[] OR "legal_list_claim_review_events"."entity_feature_organization_ids" <@ ARRAY[(SELECT current_setting('app.organization_id', true))]::text[])) WITH CHECK (("legal_list_claim_review_events"."entity_feature_gate" = 'open' OR ("legal_list_claim_review_events"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("legal_list_claim_review_events"."entity_feature_organization_ids" = '{}'::text[] OR "legal_list_claim_review_events"."entity_feature_organization_ids" <@ ARRAY[(SELECT current_setting('app.organization_id', true))]::text[]));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_claims";
  CREATE POLICY "workspace_entity_feature" ON "public"."legal_list_claims" AS RESTRICTIVE FOR ALL TO "stella" USING (("legal_list_claims"."entity_feature_gate" = 'open' OR ("legal_list_claims"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("legal_list_claims"."entity_feature_organization_ids" = '{}'::text[] OR "legal_list_claims"."entity_feature_organization_ids" <@ ARRAY[(SELECT current_setting('app.organization_id', true))]::text[])) WITH CHECK (("legal_list_claims"."entity_feature_gate" = 'open' OR ("legal_list_claims"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("legal_list_claims"."entity_feature_organization_ids" = '{}'::text[] OR "legal_list_claims"."entity_feature_organization_ids" <@ ARRAY[(SELECT current_setting('app.organization_id', true))]::text[]));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_fact_details";
  CREATE POLICY "workspace_entity_feature" ON "public"."legal_list_fact_details" AS RESTRICTIVE FOR ALL TO "stella" USING (("legal_list_fact_details"."entity_feature_gate" = 'open' OR ("legal_list_fact_details"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')))) WITH CHECK (("legal_list_fact_details"."entity_feature_gate" = 'open' OR ("legal_list_fact_details"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_generation_candidate_sources";
  CREATE POLICY "workspace_entity_feature" ON "public"."legal_list_generation_candidate_sources" AS RESTRICTIVE FOR ALL TO "stella" USING (("legal_list_generation_candidate_sources"."entity_feature_gate" = 'open' OR ("legal_list_generation_candidate_sources"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("legal_list_generation_candidate_sources"."entity_feature_workspace_ids" = '{}'::uuid[] OR "legal_list_generation_candidate_sources"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("legal_list_generation_candidate_sources"."entity_feature_gate" = 'open' OR ("legal_list_generation_candidate_sources"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("legal_list_generation_candidate_sources"."entity_feature_workspace_ids" = '{}'::uuid[] OR "legal_list_generation_candidate_sources"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_generation_candidates";
  CREATE POLICY "workspace_entity_feature" ON "public"."legal_list_generation_candidates" AS RESTRICTIVE FOR ALL TO "stella" USING (("legal_list_generation_candidates"."entity_feature_gate" = 'open' OR ("legal_list_generation_candidates"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("legal_list_generation_candidates"."entity_feature_workspace_ids" = '{}'::uuid[] OR "legal_list_generation_candidates"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("legal_list_generation_candidates"."entity_feature_gate" = 'open' OR ("legal_list_generation_candidates"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("legal_list_generation_candidates"."entity_feature_workspace_ids" = '{}'::uuid[] OR "legal_list_generation_candidates"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_generation_sources";
  CREATE POLICY "workspace_entity_feature" ON "public"."legal_list_generation_sources" AS RESTRICTIVE FOR ALL TO "stella" USING (("legal_list_generation_sources"."entity_feature_gate" = 'open' OR ("legal_list_generation_sources"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')))) WITH CHECK (("legal_list_generation_sources"."entity_feature_gate" = 'open' OR ("legal_list_generation_sources"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_item_comments";
  CREATE POLICY "workspace_entity_feature" ON "public"."legal_list_item_comments" AS RESTRICTIVE FOR ALL TO "stella" USING (("legal_list_item_comments"."entity_feature_gate" = 'open' OR ("legal_list_item_comments"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')))) WITH CHECK (("legal_list_item_comments"."entity_feature_gate" = 'open' OR ("legal_list_item_comments"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_item_reviews";
  CREATE POLICY "workspace_entity_feature" ON "public"."legal_list_item_reviews" AS RESTRICTIVE FOR ALL TO "stella" USING (("legal_list_item_reviews"."entity_feature_gate" = 'open' OR ("legal_list_item_reviews"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')))) WITH CHECK (("legal_list_item_reviews"."entity_feature_gate" = 'open' OR ("legal_list_item_reviews"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_item_sources";
  CREATE POLICY "workspace_entity_feature" ON "public"."legal_list_item_sources" AS RESTRICTIVE FOR ALL TO "stella" USING (("legal_list_item_sources"."entity_feature_gate" = 'open' OR ("legal_list_item_sources"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')))) WITH CHECK (("legal_list_item_sources"."entity_feature_gate" = 'open' OR ("legal_list_item_sources"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_items";
  CREATE POLICY "workspace_entity_feature" ON "public"."legal_list_items" AS RESTRICTIVE FOR ALL TO "stella" USING (("legal_list_items"."entity_feature_gate" = 'open' OR ("legal_list_items"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')))) WITH CHECK (("legal_list_items"."entity_feature_gate" = 'open' OR ("legal_list_items"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_verification_blocks";
  CREATE POLICY "workspace_entity_feature" ON "public"."legal_list_verification_blocks" AS RESTRICTIVE FOR ALL TO "stella" USING (("legal_list_verification_blocks"."entity_feature_gate" = 'open' OR ("legal_list_verification_blocks"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("legal_list_verification_blocks"."entity_feature_organization_ids" = '{}'::text[] OR "legal_list_verification_blocks"."entity_feature_organization_ids" <@ ARRAY[(SELECT current_setting('app.organization_id', true))]::text[])) WITH CHECK (("legal_list_verification_blocks"."entity_feature_gate" = 'open' OR ("legal_list_verification_blocks"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("legal_list_verification_blocks"."entity_feature_organization_ids" = '{}'::text[] OR "legal_list_verification_blocks"."entity_feature_organization_ids" <@ ARRAY[(SELECT current_setting('app.organization_id', true))]::text[]));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_verification_read_receipts";
  CREATE POLICY "workspace_entity_feature" ON "public"."legal_list_verification_read_receipts" AS RESTRICTIVE FOR ALL TO "stella" USING (("legal_list_verification_read_receipts"."entity_feature_gate" = 'open' OR ("legal_list_verification_read_receipts"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')))) WITH CHECK (("legal_list_verification_read_receipts"."entity_feature_gate" = 'open' OR ("legal_list_verification_read_receipts"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."legal_list_verification_runs";
  CREATE POLICY "workspace_entity_feature" ON "public"."legal_list_verification_runs" AS RESTRICTIVE FOR ALL TO "stella" USING (("legal_list_verification_runs"."entity_feature_gate" = 'open' OR ("legal_list_verification_runs"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')))) WITH CHECK (("legal_list_verification_runs"."entity_feature_gate" = 'open' OR ("legal_list_verification_runs"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."office_file_evidence";
  CREATE POLICY "workspace_entity_feature" ON "public"."office_file_evidence" AS RESTRICTIVE FOR ALL TO "stella" USING (("office_file_evidence"."entity_feature_gate" = 'open' OR ("office_file_evidence"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("office_file_evidence"."entity_feature_workspace_ids" = '{}'::uuid[] OR "office_file_evidence"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("office_file_evidence"."entity_feature_gate" = 'open' OR ("office_file_evidence"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("office_file_evidence"."entity_feature_workspace_ids" = '{}'::uuid[] OR "office_file_evidence"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."pdf_signing_sessions";
  CREATE POLICY "workspace_entity_feature" ON "public"."pdf_signing_sessions" AS RESTRICTIVE FOR ALL TO "stella" USING (("pdf_signing_sessions"."entity_feature_gate" = 'open' OR ("pdf_signing_sessions"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("pdf_signing_sessions"."entity_feature_workspace_ids" = '{}'::uuid[] OR "pdf_signing_sessions"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("pdf_signing_sessions"."entity_feature_gate" = 'open' OR ("pdf_signing_sessions"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("pdf_signing_sessions"."entity_feature_workspace_ids" = '{}'::uuid[] OR "pdf_signing_sessions"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."report_exports";
  CREATE POLICY "workspace_entity_feature" ON "public"."report_exports" AS RESTRICTIVE FOR ALL TO "stella" USING (("report_exports"."entity_feature_gate" = 'open' OR ("report_exports"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("report_exports"."entity_feature_workspace_ids" = '{}'::uuid[] OR "report_exports"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("report_exports"."entity_feature_gate" = 'open' OR ("report_exports"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("report_exports"."entity_feature_workspace_ids" = '{}'::uuid[] OR "report_exports"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."search_document_preview_passages";
  CREATE POLICY "workspace_entity_feature" ON "public"."search_document_preview_passages" AS RESTRICTIVE FOR ALL TO "stella" USING (("search_document_preview_passages"."entity_feature_gate" = 'open' OR ("search_document_preview_passages"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("search_document_preview_passages"."entity_feature_workspace_ids" = '{}'::uuid[] OR "search_document_preview_passages"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("search_document_preview_passages"."entity_feature_gate" = 'open' OR ("search_document_preview_passages"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("search_document_preview_passages"."entity_feature_workspace_ids" = '{}'::uuid[] OR "search_document_preview_passages"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."search_documents";
  CREATE POLICY "workspace_entity_feature" ON "public"."search_documents" AS RESTRICTIVE FOR ALL TO "stella" USING (("search_documents"."entity_feature_gate" = 'open' OR ("search_documents"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("search_documents"."entity_feature_workspace_ids" = '{}'::uuid[] OR "search_documents"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("search_documents"."entity_feature_gate" = 'open' OR ("search_documents"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("search_documents"."entity_feature_workspace_ids" = '{}'::uuid[] OR "search_documents"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."task_assignees";
  CREATE POLICY "workspace_entity_feature" ON "public"."task_assignees" AS RESTRICTIVE FOR ALL TO "stella" USING (("task_assignees"."entity_feature_gate" = 'open' OR ("task_assignees"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("task_assignees"."entity_feature_workspace_ids" = '{}'::uuid[] OR "task_assignees"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces))) WITH CHECK (("task_assignees"."entity_feature_gate" = 'open' OR ("task_assignees"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))) AND ("task_assignees"."entity_feature_workspace_ids" = '{}'::uuid[] OR "task_assignees"."entity_feature_workspace_ids" <@ (SELECT coalesce(nullif(current_setting('app.workspace_ids', true), '')::uuid[], '{}'::uuid[]) || coalesce(array_agg(authorized_workspace_id), '{}'::uuid[]) FROM public.stella_authorized_workspaces)));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."work_obligation_events";
  CREATE POLICY "workspace_entity_feature" ON "public"."work_obligation_events" AS RESTRICTIVE FOR ALL TO "stella" USING (("work_obligation_events"."entity_feature_gate" = 'open' OR ("work_obligation_events"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')))) WITH CHECK (("work_obligation_events"."entity_feature_gate" = 'open' OR ("work_obligation_events"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))));
  DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."work_obligations";
  CREATE POLICY "workspace_entity_feature" ON "public"."work_obligations" AS RESTRICTIVE FOR ALL TO "stella" USING (("work_obligations"."entity_feature_gate" = 'open' OR ("work_obligations"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')))) WITH CHECK (("work_obligations"."entity_feature_gate" = 'open' OR ("work_obligations"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))));
END
$finish$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.entity_feature_gate_finish() FROM PUBLIC;
