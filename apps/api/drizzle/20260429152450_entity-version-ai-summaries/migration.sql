CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"workspace_id" uuid,
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"changes" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing_codes" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"code" varchar(20) NOT NULL,
	"label" varchar(256) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "case_law_citations" (
	"id" uuid PRIMARY KEY,
	"citing_decision_id" uuid NOT NULL,
	"cited_decision_id" uuid,
	"citation_text" varchar(512) NOT NULL,
	"section_index" integer,
	"polarity" varchar(16),
	"polarity_rule_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "citations_polarity_values" CHECK ("polarity" IN ('positive','supportive','neutral','negative','unknown'))
);
--> statement-breakpoint
CREATE TABLE "case_law_court_weights" (
	"id" uuid PRIMARY KEY,
	"country" varchar(3) NOT NULL,
	"court_pattern" varchar(512) NOT NULL,
	"tier" integer NOT NULL,
	"tier_label" varchar(64) NOT NULL,
	"weight" double precision NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_law_decisions" (
	"id" uuid PRIMARY KEY,
	"source_id" uuid NOT NULL,
	"case_number" varchar(256) NOT NULL,
	"slug" varchar(256),
	"ecli" varchar(256),
	"court" varchar(512) NOT NULL,
	"country" varchar(3) NOT NULL,
	"language" varchar(8) NOT NULL,
	"language_group_key" varchar(512),
	"decision_date" date,
	"decision_type" varchar(128),
	"fulltext" text,
	"sections" jsonb,
	"document_ast" jsonb,
	"analysis" jsonb,
	"parser_version" smallint DEFAULT 0,
	"source_raw" text,
	"source_raw_s3_key" varchar(512),
	"source_raw_content_type" varchar(128),
	"source_url" varchar(2048),
	"document_url" varchar(2048),
	"metadata" jsonb DEFAULT '{}',
	"source_hash" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_law_fts_configs" (
	"language" varchar(8) PRIMARY KEY,
	"regconfig" varchar(64) NOT NULL,
	"use_unaccent" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_law_ingestion_events" (
	"id" uuid PRIMARY KEY,
	"source_id" uuid NOT NULL,
	"status" varchar(16) NOT NULL,
	"inserted" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"search_vector_failures" integer DEFAULT 0 NOT NULL,
	"pages_processed" integer DEFAULT 0 NOT NULL,
	"cursor_before" text,
	"cursor_after" text,
	"duration_ms" integer NOT NULL,
	"error_message" varchar(2048),
	"started_at" timestamp NOT NULL,
	"finished_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_law_ingestion_failures" (
	"id" uuid PRIMARY KEY,
	"source_id" uuid NOT NULL,
	"case_number" varchar(256) NOT NULL,
	"language" varchar(8),
	"error_type" varchar(128) NOT NULL,
	"error_message" varchar(2048) NOT NULL,
	"cursor" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_law_matter_links" (
	"id" uuid PRIMARY KEY,
	"decision_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"note" text,
	"linked_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "case_law_matter_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "case_law_polarity_rules" (
	"id" uuid PRIMARY KEY,
	"pattern" varchar(512) NOT NULL,
	"polarity" varchar(16) NOT NULL,
	"language" varchar(8) NOT NULL,
	"source" varchar(16) DEFAULT 'manual' NOT NULL,
	"confidence" double precision DEFAULT 1 NOT NULL,
	"match_count" integer DEFAULT 0 NOT NULL,
	"surface_forms" jsonb DEFAULT '[]',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "polarity_rules_polarity_values" CHECK ("polarity" IN ('positive','supportive','neutral','negative','unknown')),
	CONSTRAINT "polarity_rules_source_values" CHECK ("source" IN ('manual','llm-proposed','llm-promoted'))
);
--> statement-breakpoint
CREATE TABLE "case_law_search_documents" (
	"decision_id" uuid PRIMARY KEY,
	"title" text DEFAULT '' NOT NULL,
	"searchable_text" text DEFAULT '' NOT NULL,
	"language" varchar(10),
	"regconfig" varchar(64) DEFAULT 'simple' NOT NULL,
	"tsv" tsvector,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_law_sources" (
	"id" uuid PRIMARY KEY,
	"adapter_key" varchar(64) NOT NULL,
	"name" varchar(256) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sync_cursor" text,
	"last_sync_at" timestamp,
	"config" jsonb DEFAULT '{}',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY,
	"thread_id" uuid NOT NULL,
	"workspace_id" uuid,
	"user_id" text NOT NULL,
	"role" varchar(16) NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid,
	"user_id" text NOT NULL,
	"title" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_threads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "clause_categories" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"parent_id" uuid,
	"name" varchar(256) NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clause_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "clause_variants" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"clause_id" uuid NOT NULL,
	"label" varchar(256) NOT NULL,
	"body" jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clause_variants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "clause_versions" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"clause_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clause_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "clauses" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"category_id" uuid,
	"title" varchar(256) NOT NULL,
	"description" text,
	"usage_notes" text,
	"language" varchar(10),
	"body" jsonb NOT NULL,
	"metadata" jsonb,
	"search_vector" tsvector,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "clauses_id_org_unq" UNIQUE("id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "clauses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contact_relationships" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"person_id" uuid NOT NULL,
	"related_contact_id" uuid NOT NULL,
	"relationship_type" text NOT NULL,
	"title" varchar(256),
	"is_primary" boolean DEFAULT false NOT NULL,
	"start_date" date,
	"end_date" date,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "contact_relationships_no_self_reference_check" CHECK ("person_id" != "related_contact_id")
);
--> statement-breakpoint
ALTER TABLE "contact_relationships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"type" text NOT NULL,
	"prefix" varchar(32),
	"first_name" varchar(256),
	"middle_name" varchar(256),
	"last_name" varchar(256),
	"suffix" varchar(32),
	"organization_name" varchar(512),
	"display_name" varchar(512) NOT NULL,
	"notes" text,
	"emails" jsonb,
	"phones" jsonb,
	"addresses" jsonb,
	"tags" text[],
	"metadata" jsonb,
	"color" varchar(32),
	"registration_number" varchar(64),
	"tax_id" varchar(64),
	"bank_accounts" jsonb,
	"billing_address" jsonb,
	"default_hourly_rate" integer,
	"currency" varchar(3),
	"payment_term_days" integer,
	"originating_attorney_id" text,
	"responsible_attorney_id" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "desktop_edit_sessions" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"base_version_id" uuid NOT NULL,
	"finalized_version_id" uuid,
	"created_by" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"file_name" varchar(256) NOT NULL,
	"checkpoint_file_id" uuid NOT NULL,
	"checkpoint_sha256_hex" varchar(64),
	"checkpoint_size_bytes" integer,
	"checkpoint_scan_warnings" jsonb,
	"checkpoint_updated_at" timestamp,
	"session_token_hash" varchar(64) NOT NULL,
	"token_expires_at" timestamp NOT NULL,
	"takeover_requested_by" text,
	"takeover_requested_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"closed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "desktop_edit_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "document_counters" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"kind" text DEFAULT 'document' NOT NULL,
	"parent_id" uuid,
	"name" text,
	"created_by" text,
	"last_edited_by" text,
	"current_version_id" uuid,
	"doc_sequence" integer,
	"status" varchar(32),
	"priority" varchar(16),
	"due_date" date,
	"sort_order" varchar(64),
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "entities_id_ws_unq" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "entities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "entity_links" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"source_entity_id" uuid NOT NULL,
	"target_entity_id" uuid NOT NULL,
	"link_type" varchar(32) DEFAULT 'related' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "entity_links_no_self_ref_check" CHECK ("source_entity_id" != "target_entity_id")
);
--> statement-breakpoint
ALTER TABLE "entity_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "entity_version_ai_summaries" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"entity_version_id" uuid NOT NULL,
	"prompt_version" smallint NOT NULL,
	"source_text_hash" varchar(64) NOT NULL,
	"summary" text NOT NULL,
	"language" varchar(10),
	"model_provider" varchar(64) NOT NULL,
	"model_id" varchar(256) NOT NULL,
	"generated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entity_version_ai_summaries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "entity_versions" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"version_number" integer DEFAULT 1 NOT NULL,
	"stamp" varchar(128),
	"label" varchar(128),
	"description" varchar(1024),
	"diff_words_added" integer,
	"diff_words_removed" integer,
	"verification_code" varchar(16),
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entity_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text,
	"matter_id" uuid NOT NULL,
	"date_incurred" date NOT NULL,
	"amount" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"invoice_description" text,
	"billable" boolean DEFAULT true NOT NULL,
	"markup" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"invoice_id" uuid,
	"receipt_file_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "expenses_amount_positive_check" CHECK ("amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "expenses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "extracted_content" (
	"entity_id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"workspace_id" uuid NOT NULL,
	"ciphertext" bytea NOT NULL,
	"iv" bytea NOT NULL,
	"char_count" integer NOT NULL,
	"language" varchar(10),
	"extracted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fields" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"entity_version_id" uuid NOT NULL,
	"file_id" uuid,
	"content" jsonb NOT NULL,
	CONSTRAINT "fields_id_ws_unq" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "fields" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"workspace_id" uuid NOT NULL,
	"invoice_number" varchar(64) NOT NULL,
	"reference" varchar(256),
	"status" text DEFAULT 'draft' NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date,
	"currency" varchar(3) NOT NULL,
	"total_amount" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "justifications" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"content" jsonb NOT NULL,
	"bounding_boxes" jsonb,
	"file_field_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL
);
--> statement-breakpoint
ALTER TABLE "justifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "matter_counters" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"scope_key" varchar(128) NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "matter_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organization_settings" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL UNIQUE,
	"matter_number_pattern" varchar(128) DEFAULT '{SEQ}' NOT NULL,
	"matter_number_padding" integer DEFAULT 3 NOT NULL,
	"document_stamp_enabled" boolean DEFAULT true NOT NULL,
	"ai_config_encrypted" bytea,
	"ai_config_iv" bytea,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"name" varchar(256) NOT NULL,
	"status" text DEFAULT 'uninitialized' NOT NULL,
	"content" jsonb NOT NULL,
	"tool" jsonb NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"kinds" varchar(64)[],
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "properties_id_ws_unq" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "properties" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "property_dependencies" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"depends_on_property_id" uuid NOT NULL,
	"condition" jsonb,
	CONSTRAINT "property_dependencies_no_self_reference_check" CHECK ("property_id" != "depends_on_property_id")
);
--> statement-breakpoint
ALTER TABLE "property_dependencies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rate_entries" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"rate_table_id" uuid NOT NULL,
	"user_id" text,
	"hourly_rate" integer NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rate_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "rate_tables" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(256) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"client_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rate_tables" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "search_documents" (
	"entity_id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"searchable_text" text DEFAULT '' NOT NULL,
	"language" varchar(10),
	"tsv" tsvector,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_assignees" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_assignees" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "template_categories" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"parent_id" uuid,
	"name" varchar(256) NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "template_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "template_clauses" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"template_id" uuid NOT NULL,
	"clause_id" uuid,
	"clause_variant_id" uuid,
	"clause_version_id" uuid,
	"slot_name" varchar(128),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"inserted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "template_clauses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "template_fills" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"template_id" uuid,
	"user_id" text NOT NULL,
	"format" text NOT NULL,
	"status" text NOT NULL,
	"unmatched_count" integer DEFAULT 0 NOT NULL,
	"unused_count" integer DEFAULT 0 NOT NULL,
	"structure_errors" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "template_fills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "template_versions" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"s3_key" varchar(512) NOT NULL,
	"manifest" jsonb,
	"field_count" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "template_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"category_id" uuid,
	"name" varchar(256) NOT NULL,
	"file_name" varchar(256) NOT NULL,
	"s3_key" varchar(512) NOT NULL,
	"size_bytes" integer NOT NULL,
	"manifest" jsonb,
	"field_count" integer DEFAULT 0 NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "templates_id_org_unq" UNIQUE("id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text,
	"matter_id" uuid NOT NULL,
	"date_worked" date NOT NULL,
	"timezone_id" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"billed_minutes" integer NOT NULL,
	"rate_at_entry" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"narrative" text NOT NULL,
	"invoice_narrative" text,
	"billable" boolean DEFAULT true NOT NULL,
	"no_charge" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"task_code" varchar(20),
	"activity_code" varchar(20),
	"invoice_id" uuid,
	"split_group_id" uuid,
	"timer_started_at" timestamp with time zone,
	"timer_stopped_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "time_entries_duration_or_timer_check" CHECK ("duration_minutes" > 0 OR "timer_started_at" IS NOT NULL),
	CONSTRAINT "time_entries_billed_minutes_check" CHECK ("billed_minutes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "time_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_files" (
	"id" uuid PRIMARY KEY,
	"user_id" text NOT NULL,
	"file_name" varchar(512) NOT NULL,
	"mime_type" varchar(255) NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256_hex" varchar(64) NOT NULL,
	"s3_key" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"scan_warnings" text[],
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_contacts" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"role" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_contacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"user_id" varchar(128) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_views" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"name" varchar(256) NOT NULL,
	"layout" jsonb NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_views" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"name" varchar(256) NOT NULL,
	"reference" varchar(64) NOT NULL,
	"client_id" uuid NOT NULL,
	"billing_reference" varchar(128),
	"color" varchar(32),
	"status" text DEFAULT 'active' NOT NULL,
	"last_activity_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_org_reference_uidx" UNIQUE("organization_id","reference")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jwks" (
	"id" text PRIMARY KEY,
	"alg" text,
	"crv" text,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"last_active_workspace_id" text,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_access_token" (
	"id" text PRIMARY KEY,
	"token" text NOT NULL UNIQUE,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text,
	"reference_id" text,
	"refresh_id" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"scopes" text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client" (
	"id" text PRIMARY KEY,
	"client_id" text NOT NULL UNIQUE,
	"client_secret" text,
	"disabled" boolean DEFAULT false NOT NULL,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" text[],
	"user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text[] NOT NULL,
	"post_logout_redirect_uris" text[],
	"token_endpoint_auth_method" text,
	"grant_types" text[],
	"response_types" text[],
	"public" boolean,
	"type" text,
	"require_pkce" boolean,
	"reference_id" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "oauth_consent" (
	"id" text PRIMARY KEY,
	"client_id" text NOT NULL,
	"user_id" text,
	"reference_id" text,
	"scopes" text[] NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_token" (
	"id" text PRIMARY KEY,
	"token" text NOT NULL UNIQUE,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text NOT NULL,
	"reference_id" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked" timestamp,
	"auth_time" timestamp,
	"scopes" text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"slug" text NOT NULL UNIQUE,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"timezone_id" text DEFAULT 'UTC' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_id_idx" ON "audit_logs" ("organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX "audit_logs_org_workspace_created_id_idx" ON "audit_logs" ("organization_id","workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "audit_logs_org_resource_created_id_idx" ON "audit_logs" ("organization_id","resource_type","resource_id","created_at","id");--> statement-breakpoint
CREATE INDEX "audit_logs_org_user_created_id_idx" ON "audit_logs" ("organization_id","user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "billing_codes_ws_type_active_idx" ON "billing_codes" ("workspace_id","type","active");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_codes_ws_type_code_uidx" ON "billing_codes" ("workspace_id","type","code");--> statement-breakpoint
CREATE INDEX "case_law_citations_citing_idx" ON "case_law_citations" ("citing_decision_id");--> statement-breakpoint
CREATE INDEX "case_law_citations_cited_idx" ON "case_law_citations" ("cited_decision_id") WHERE ("cited_decision_id" is not null);--> statement-breakpoint
CREATE INDEX "case_law_citations_polarity_null_idx" ON "case_law_citations" ("polarity") WHERE ("polarity" is null);--> statement-breakpoint
CREATE UNIQUE INDEX "case_law_court_weights_country_pattern_idx" ON "case_law_court_weights" ("country","court_pattern");--> statement-breakpoint
CREATE INDEX "case_law_court_weights_country_idx" ON "case_law_court_weights" ("country");--> statement-breakpoint
CREATE UNIQUE INDEX "case_law_decisions_source_case_lang_idx" ON "case_law_decisions" ("source_id","case_number","language");--> statement-breakpoint
CREATE INDEX "case_law_decisions_case_number_idx" ON "case_law_decisions" ("case_number");--> statement-breakpoint
CREATE INDEX "case_law_decisions_court_idx" ON "case_law_decisions" ("court");--> statement-breakpoint
CREATE INDEX "case_law_decisions_country_idx" ON "case_law_decisions" ("country");--> statement-breakpoint
CREATE INDEX "case_law_decisions_date_idx" ON "case_law_decisions" ("decision_date");--> statement-breakpoint
CREATE INDEX "case_law_decisions_ecli_idx" ON "case_law_decisions" ("ecli") WHERE ("ecli" is not null);--> statement-breakpoint
CREATE INDEX "case_law_decisions_lang_group_idx" ON "case_law_decisions" ("language_group_key") WHERE ("language_group_key" is not null);--> statement-breakpoint
CREATE INDEX "case_law_decisions_created_at_idx" ON "case_law_decisions" ("created_at");--> statement-breakpoint
CREATE INDEX "case_law_ingestion_events_source_idx" ON "case_law_ingestion_events" ("source_id");--> statement-breakpoint
CREATE INDEX "case_law_ingestion_events_finished_idx" ON "case_law_ingestion_events" ("finished_at");--> statement-breakpoint
CREATE INDEX "case_law_ingestion_failures_source_idx" ON "case_law_ingestion_failures" ("source_id");--> statement-breakpoint
CREATE INDEX "case_law_ingestion_failures_error_type_idx" ON "case_law_ingestion_failures" ("error_type");--> statement-breakpoint
CREATE INDEX "case_law_ingestion_failures_created_idx" ON "case_law_ingestion_failures" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "case_law_matter_links_decision_ws_idx" ON "case_law_matter_links" ("decision_id","workspace_id");--> statement-breakpoint
CREATE INDEX "case_law_matter_links_workspace_idx" ON "case_law_matter_links" ("workspace_id");--> statement-breakpoint
CREATE INDEX "case_law_polarity_rules_lang_idx" ON "case_law_polarity_rules" ("language");--> statement-breakpoint
CREATE UNIQUE INDEX "case_law_polarity_rules_pattern_lang_idx" ON "case_law_polarity_rules" ("pattern","language");--> statement-breakpoint
CREATE INDEX "case_law_search_docs_tsv_idx" ON "case_law_search_documents" USING gin ("tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "case_law_sources_adapter_key_idx" ON "case_law_sources" ("adapter_key");--> statement-breakpoint
CREATE INDEX "chat_messages_thread_created_idx" ON "chat_messages" ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_messages_user_workspace_created_idx" ON "chat_messages" ("user_id","workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_threads_workspace_user_idx" ON "chat_threads" ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "chat_threads_user_updated_idx" ON "chat_threads" ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "clause_categories_organization_id_idx" ON "clause_categories" ("organization_id");--> statement-breakpoint
CREATE INDEX "clause_categories_org_parent_idx" ON "clause_categories" ("organization_id","parent_id");--> statement-breakpoint
CREATE INDEX "clause_variants_clause_id_idx" ON "clause_variants" ("clause_id");--> statement-breakpoint
CREATE INDEX "clause_variants_organization_id_idx" ON "clause_variants" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clause_versions_clause_version_uidx" ON "clause_versions" ("clause_id","version");--> statement-breakpoint
CREATE INDEX "clause_versions_organization_id_idx" ON "clause_versions" ("organization_id");--> statement-breakpoint
CREATE INDEX "clauses_organization_id_idx" ON "clauses" ("organization_id");--> statement-breakpoint
CREATE INDEX "clauses_org_category_idx" ON "clauses" ("organization_id","category_id");--> statement-breakpoint
CREATE INDEX "clauses_org_created_at_idx" ON "clauses" ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "clauses_search_vector_gin_idx" ON "clauses" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "contact_relationships_person_id_idx" ON "contact_relationships" ("person_id");--> statement-breakpoint
CREATE INDEX "contact_relationships_related_contact_id_idx" ON "contact_relationships" ("related_contact_id");--> statement-breakpoint
CREATE INDEX "contact_relationships_org_id_idx" ON "contact_relationships" ("organization_id");--> statement-breakpoint
CREATE INDEX "contacts_organization_id_idx" ON "contacts" ("organization_id");--> statement-breakpoint
CREATE INDEX "contacts_org_type_idx" ON "contacts" ("organization_id","type");--> statement-breakpoint
CREATE INDEX "contacts_org_display_name_idx" ON "contacts" ("organization_id","display_name");--> statement-breakpoint
CREATE INDEX "contacts_org_first_name_idx" ON "contacts" ("organization_id","first_name");--> statement-breakpoint
CREATE INDEX "contacts_org_last_name_idx" ON "contacts" ("organization_id","last_name");--> statement-breakpoint
CREATE INDEX "contacts_org_org_name_idx" ON "contacts" ("organization_id","organization_name");--> statement-breakpoint
CREATE INDEX "desktop_edit_sessions_workspace_id_idx" ON "desktop_edit_sessions" ("workspace_id");--> statement-breakpoint
CREATE INDEX "desktop_edit_sessions_entity_id_idx" ON "desktop_edit_sessions" ("entity_id");--> statement-breakpoint
CREATE INDEX "desktop_edit_sessions_property_id_idx" ON "desktop_edit_sessions" ("property_id");--> statement-breakpoint
CREATE INDEX "desktop_edit_sessions_base_version_id_idx" ON "desktop_edit_sessions" ("base_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_edit_sessions_session_token_hash_uidx" ON "desktop_edit_sessions" ("session_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_edit_sessions_open_uidx" ON "desktop_edit_sessions" ("created_by","entity_id","property_id") WHERE "status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "document_counters_ws_uidx" ON "document_counters" ("workspace_id");--> statement-breakpoint
CREATE INDEX "entities_workspace_id_idx" ON "entities" ("workspace_id");--> statement-breakpoint
CREATE INDEX "entities_parent_id_idx" ON "entities" ("parent_id") WHERE ("parent_id" is not null);--> statement-breakpoint
CREATE INDEX "entities_workspace_name_idx" ON "entities" ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "entities_ws_doc_seq_uidx" ON "entities" ("workspace_id","doc_sequence") WHERE ("doc_sequence" is not null);--> statement-breakpoint
CREATE INDEX "entities_workspace_status_idx" ON "entities" ("workspace_id","status") WHERE ("status" is not null);--> statement-breakpoint
CREATE INDEX "entities_workspace_priority_idx" ON "entities" ("workspace_id","priority") WHERE ("priority" is not null);--> statement-breakpoint
CREATE INDEX "entities_due_date_idx" ON "entities" ("workspace_id","due_date") WHERE ("due_date" is not null);--> statement-breakpoint
CREATE INDEX "entity_links_workspace_id_idx" ON "entity_links" ("workspace_id");--> statement-breakpoint
CREATE INDEX "entity_links_source_idx" ON "entity_links" ("source_entity_id");--> statement-breakpoint
CREATE INDEX "entity_links_target_idx" ON "entity_links" ("target_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_links_source_target_uidx" ON "entity_links" ("source_entity_id","target_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_links_pair_uidx" ON "entity_links" (LEAST("source_entity_id", "target_entity_id"),GREATEST("source_entity_id", "target_entity_id"));--> statement-breakpoint
CREATE INDEX "entity_version_ai_summaries_workspace_idx" ON "entity_version_ai_summaries" ("workspace_id");--> statement-breakpoint
CREATE INDEX "entity_version_ai_summaries_entity_idx" ON "entity_version_ai_summaries" ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_version_ai_summaries_version_prompt_uidx" ON "entity_version_ai_summaries" ("entity_version_id","prompt_version");--> statement-breakpoint
CREATE INDEX "entity_versions_entity_id_idx" ON "entity_versions" ("entity_id");--> statement-breakpoint
CREATE INDEX "entity_versions_stamp_idx" ON "entity_versions" ("stamp") WHERE ("stamp" is not null);--> statement-breakpoint
CREATE UNIQUE INDEX "entity_versions_vcode_uidx" ON "entity_versions" ("verification_code") WHERE ("verification_code" is not null);--> statement-breakpoint
CREATE INDEX "entity_versions_workspace_id_idx" ON "entity_versions" ("workspace_id");--> statement-breakpoint
CREATE INDEX "expenses_ws_matter_status_idx" ON "expenses" ("workspace_id","matter_id","status");--> statement-breakpoint
CREATE INDEX "expenses_ws_user_date_idx" ON "expenses" ("workspace_id","user_id","date_incurred");--> statement-breakpoint
CREATE INDEX "expenses_invoice_idx" ON "expenses" ("invoice_id");--> statement-breakpoint
CREATE INDEX "extracted_content_org_id_idx" ON "extracted_content" ("organization_id");--> statement-breakpoint
CREATE INDEX "extracted_content_workspace_id_idx" ON "extracted_content" ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fields_property_id_entity_version_id_key" ON "fields" ("property_id","entity_version_id");--> statement-breakpoint
CREATE INDEX "fields_workspace_id_idx" ON "fields" ("workspace_id");--> statement-breakpoint
CREATE INDEX "invoices_ws_status_idx" ON "invoices" ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_ws_number_uidx" ON "invoices" ("workspace_id","invoice_number");--> statement-breakpoint
CREATE UNIQUE INDEX "justifications_field_id_key" ON "justifications" ("field_id");--> statement-breakpoint
CREATE INDEX "justifications_workspace_id_idx" ON "justifications" ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "matter_counters_org_scope_uidx" ON "matter_counters" ("organization_id","scope_key");--> statement-breakpoint
CREATE INDEX "properties_workspace_id_idx" ON "properties" ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "property_dependencies_property_id_depends_on_property_id_key" ON "property_dependencies" ("property_id","depends_on_property_id");--> statement-breakpoint
CREATE INDEX "property_dependencies_property_id_idx" ON "property_dependencies" ("property_id");--> statement-breakpoint
CREATE INDEX "property_dependencies_depends_on_property_id_idx" ON "property_dependencies" ("depends_on_property_id");--> statement-breakpoint
CREATE INDEX "property_dependencies_workspace_id_idx" ON "property_dependencies" ("workspace_id");--> statement-breakpoint
CREATE INDEX "rate_entries_table_user_from_idx" ON "rate_entries" ("rate_table_id","user_id","effective_from");--> statement-breakpoint
CREATE INDEX "rate_entries_workspace_id_idx" ON "rate_entries" ("workspace_id");--> statement-breakpoint
CREATE INDEX "rate_tables_ws_default_idx" ON "rate_tables" ("workspace_id","is_default");--> statement-breakpoint
CREATE INDEX "rate_tables_ws_client_idx" ON "rate_tables" ("workspace_id","client_id");--> statement-breakpoint
CREATE INDEX "search_documents_org_id_idx" ON "search_documents" ("organization_id");--> statement-breakpoint
CREATE INDEX "search_documents_org_workspace_idx" ON "search_documents" ("organization_id","workspace_id");--> statement-breakpoint
CREATE INDEX "search_documents_tsv_idx" ON "search_documents" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "task_assignees_workspace_id_idx" ON "task_assignees" ("workspace_id");--> statement-breakpoint
CREATE INDEX "task_assignees_entity_id_idx" ON "task_assignees" ("entity_id");--> statement-breakpoint
CREATE INDEX "task_assignees_user_id_idx" ON "task_assignees" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_assignees_entity_user_uidx" ON "task_assignees" ("entity_id","user_id");--> statement-breakpoint
CREATE INDEX "template_categories_organization_id_idx" ON "template_categories" ("organization_id");--> statement-breakpoint
CREATE INDEX "template_categories_org_parent_idx" ON "template_categories" ("organization_id","parent_id");--> statement-breakpoint
CREATE INDEX "template_clauses_template_id_idx" ON "template_clauses" ("template_id");--> statement-breakpoint
CREATE INDEX "template_clauses_clause_id_idx" ON "template_clauses" ("clause_id");--> statement-breakpoint
CREATE UNIQUE INDEX "template_clauses_template_slot_uidx" ON "template_clauses" ("template_id","slot_name") WHERE ("slot_name" is not null);--> statement-breakpoint
CREATE INDEX "template_clauses_organization_id_idx" ON "template_clauses" ("organization_id");--> statement-breakpoint
CREATE INDEX "template_fills_organization_id_idx" ON "template_fills" ("organization_id");--> statement-breakpoint
CREATE INDEX "template_fills_org_created_at_idx" ON "template_fills" ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "template_fills_org_template_idx" ON "template_fills" ("organization_id","template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "template_versions_template_version_uidx" ON "template_versions" ("template_id","version");--> statement-breakpoint
CREATE INDEX "template_versions_template_id_idx" ON "template_versions" ("template_id");--> statement-breakpoint
CREATE INDEX "template_versions_organization_id_idx" ON "template_versions" ("organization_id");--> statement-breakpoint
CREATE INDEX "templates_organization_id_idx" ON "templates" ("organization_id");--> statement-breakpoint
CREATE INDEX "templates_organization_id_name_idx" ON "templates" ("organization_id","name");--> statement-breakpoint
CREATE INDEX "templates_organization_id_created_at_idx" ON "templates" ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "templates_org_category_idx" ON "templates" ("organization_id","category_id");--> statement-breakpoint
CREATE INDEX "time_entries_ws_user_date_idx" ON "time_entries" ("workspace_id","user_id","date_worked");--> statement-breakpoint
CREATE INDEX "time_entries_ws_matter_status_idx" ON "time_entries" ("workspace_id","matter_id","status");--> statement-breakpoint
CREATE INDEX "time_entries_ws_status_idx" ON "time_entries" ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "time_entries_invoice_idx" ON "time_entries" ("invoice_id");--> statement-breakpoint
CREATE INDEX "user_files_user_created_idx" ON "user_files" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "user_files_thread_created_idx" ON "user_files" ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "user_files_user_hash_idx" ON "user_files" ("user_id","sha256_hex");--> statement-breakpoint
CREATE INDEX "user_files_s3_key_idx" ON "user_files" ("s3_key");--> statement-breakpoint
CREATE INDEX "workspace_contacts_workspace_id_idx" ON "workspace_contacts" ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_contacts_contact_id_idx" ON "workspace_contacts" ("contact_id");--> statement-breakpoint
CREATE INDEX "workspace_contacts_org_workspace_idx" ON "workspace_contacts" ("organization_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_contacts_ws_contact_role_uidx" ON "workspace_contacts" ("workspace_id","contact_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_workspace_user_uidx" ON "workspace_members" ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members" ("user_id");--> statement-breakpoint
CREATE INDEX "workspace_views_workspace_position_idx" ON "workspace_views" ("workspace_id","position");--> statement-breakpoint
CREATE INDEX "workspaces_organization_id_idx" ON "workspaces" ("organization_id");--> statement-breakpoint
CREATE INDEX "workspaces_org_client_id_idx" ON "workspaces" ("organization_id","client_id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" ("user_id");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" ("user_id");--> statement-breakpoint
CREATE INDEX "member_lastActiveWorkspaceId_idx" ON "member" ("last_active_workspace_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_client_id_idx" ON "oauth_access_token" ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_session_id_idx" ON "oauth_access_token" ("session_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_user_id_idx" ON "oauth_access_token" ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_reference_id_idx" ON "oauth_access_token" ("reference_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_refresh_id_idx" ON "oauth_access_token" ("refresh_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_client_client_id_uidx" ON "oauth_client" ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_client_user_id_idx" ON "oauth_client" ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_client_reference_id_idx" ON "oauth_client" ("reference_id");--> statement-breakpoint
CREATE INDEX "oauth_consent_client_id_idx" ON "oauth_consent" ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_consent_user_id_idx" ON "oauth_consent" ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_consent_reference_id_idx" ON "oauth_consent" ("reference_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_client_id_idx" ON "oauth_refresh_token" ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_session_id_idx" ON "oauth_refresh_token" ("session_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_user_id_idx" ON "oauth_refresh_token" ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_reference_id_idx" ON "oauth_refresh_token" ("reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_uidx" ON "organization" ("slug");--> statement-breakpoint
CREATE INDEX "session_userId_activeOrgId_idx" ON "session" ("user_id","active_organization_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_codes" ADD CONSTRAINT "billing_codes_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "billing_codes" ADD CONSTRAINT "billing_codes_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "case_law_citations" ADD CONSTRAINT "case_law_citations_TrIL82Lk6lvs_fkey" FOREIGN KEY ("citing_decision_id") REFERENCES "case_law_decisions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "case_law_citations" ADD CONSTRAINT "case_law_citations_cited_decision_id_case_law_decisions_id_fkey" FOREIGN KEY ("cited_decision_id") REFERENCES "case_law_decisions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "case_law_citations" ADD CONSTRAINT "case_law_citations_CFMSzPZ9CqPN_fkey" FOREIGN KEY ("polarity_rule_id") REFERENCES "case_law_polarity_rules"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "case_law_decisions" ADD CONSTRAINT "case_law_decisions_source_id_case_law_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "case_law_sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "case_law_ingestion_events" ADD CONSTRAINT "case_law_ingestion_events_source_id_case_law_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "case_law_sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "case_law_ingestion_failures" ADD CONSTRAINT "case_law_ingestion_failures_source_id_case_law_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "case_law_sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "case_law_matter_links" ADD CONSTRAINT "case_law_matter_links_decision_id_case_law_decisions_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "case_law_decisions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "case_law_matter_links" ADD CONSTRAINT "case_law_matter_links_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "case_law_matter_links" ADD CONSTRAINT "case_law_matter_links_linked_by_user_id_fkey" FOREIGN KEY ("linked_by") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "case_law_search_documents" ADD CONSTRAINT "case_law_search_documents_kXLzz9FaYvKW_fkey" FOREIGN KEY ("decision_id") REFERENCES "case_law_decisions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_chat_threads_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "chat_threads"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "clause_categories" ADD CONSTRAINT "clause_categories_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "clause_categories" ADD CONSTRAINT "clause_categories_parent_id_clause_categories_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "clause_categories"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "clause_variants" ADD CONSTRAINT "clause_variants_Sq2OGaUBZptr_fkey" FOREIGN KEY ("clause_id","organization_id") REFERENCES "clauses"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "clause_versions" ADD CONSTRAINT "clause_versions_DbXN30aFYsZw_fkey" FOREIGN KEY ("clause_id","organization_id") REFERENCES "clauses"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "clauses" ADD CONSTRAINT "clauses_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "clauses" ADD CONSTRAINT "clauses_category_id_clause_categories_id_fkey" FOREIGN KEY ("category_id") REFERENCES "clause_categories"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "clauses" ADD CONSTRAINT "clauses_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "contact_relationships" ADD CONSTRAINT "contact_relationships_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "contact_relationships" ADD CONSTRAINT "contact_relationships_person_id_contacts_id_fkey" FOREIGN KEY ("person_id") REFERENCES "contacts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "contact_relationships" ADD CONSTRAINT "contact_relationships_related_contact_id_contacts_id_fkey" FOREIGN KEY ("related_contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_originating_attorney_id_user_id_fkey" FOREIGN KEY ("originating_attorney_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_responsible_attorney_id_user_id_fkey" FOREIGN KEY ("responsible_attorney_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "desktop_edit_sessions" ADD CONSTRAINT "desktop_edit_sessions_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "desktop_edit_sessions" ADD CONSTRAINT "desktop_edit_sessions_base_version_id_entity_versions_id_fkey" FOREIGN KEY ("base_version_id") REFERENCES "entity_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "desktop_edit_sessions" ADD CONSTRAINT "desktop_edit_sessions_gS7cgzDJSTZ3_fkey" FOREIGN KEY ("finalized_version_id") REFERENCES "entity_versions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "desktop_edit_sessions" ADD CONSTRAINT "desktop_edit_sessions_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "desktop_edit_sessions" ADD CONSTRAINT "desktop_edit_sessions_takeover_requested_by_user_id_fkey" FOREIGN KEY ("takeover_requested_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "desktop_edit_sessions" ADD CONSTRAINT "desktop_edit_sessions_gzhRuxUdBb4T_fkey" FOREIGN KEY ("entity_id","workspace_id") REFERENCES "entities"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "desktop_edit_sessions" ADD CONSTRAINT "desktop_edit_sessions_XQXU3ScE6Xeb_fkey" FOREIGN KEY ("property_id","workspace_id") REFERENCES "properties"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_counters" ADD CONSTRAINT "document_counters_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_parent_id_entities_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "entities"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_last_edited_by_user_id_fkey" FOREIGN KEY ("last_edited_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_current_version_id_entity_versions_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "entity_versions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "entity_links" ADD CONSTRAINT "entity_links_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entity_links" ADD CONSTRAINT "entity_links_source_entity_id_entities_id_fkey" FOREIGN KEY ("source_entity_id") REFERENCES "entities"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entity_links" ADD CONSTRAINT "entity_links_target_entity_id_entities_id_fkey" FOREIGN KEY ("target_entity_id") REFERENCES "entities"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entity_version_ai_summaries" ADD CONSTRAINT "entity_version_ai_summaries_NW3EPY4ryHo6_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entity_version_ai_summaries" ADD CONSTRAINT "entity_version_ai_summaries_FjBi81UZUToX_fkey" FOREIGN KEY ("entity_version_id") REFERENCES "entity_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entity_version_ai_summaries" ADD CONSTRAINT "entity_version_ai_summaries_gNAYq788wxRg_fkey" FOREIGN KEY ("entity_id","workspace_id") REFERENCES "entities"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entity_versions" ADD CONSTRAINT "entity_versions_WcF7jWbCfGr9_fkey" FOREIGN KEY ("entity_id","workspace_id") REFERENCES "entities"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_matter_id_entities_id_fkey" FOREIGN KEY ("matter_id") REFERENCES "entities"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_invoice_id_invoices_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "extracted_content" ADD CONSTRAINT "extracted_content_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "extracted_content" ADD CONSTRAINT "extracted_content_LyGnZb6pbaKY_fkey" FOREIGN KEY ("entity_id","workspace_id") REFERENCES "entities"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_entity_version_id_entity_versions_id_fkey" FOREIGN KEY ("entity_version_id") REFERENCES "entity_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_property_id_workspace_id_properties_id_workspace_id_fkey" FOREIGN KEY ("property_id","workspace_id") REFERENCES "properties"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "justifications" ADD CONSTRAINT "justifications_k5tJTa4XHpV4_fkey" FOREIGN KEY ("field_id","workspace_id") REFERENCES "fields"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "matter_counters" ADD CONSTRAINT "matter_counters_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "property_dependencies" ADD CONSTRAINT "property_dependencies_ybZv9N89qdKl_fkey" FOREIGN KEY ("property_id","workspace_id") REFERENCES "properties"("id","workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "property_dependencies" ADD CONSTRAINT "property_dependencies_zmwulDNP36AP_fkey" FOREIGN KEY ("depends_on_property_id","workspace_id") REFERENCES "properties"("id","workspace_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "rate_entries" ADD CONSTRAINT "rate_entries_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "rate_entries" ADD CONSTRAINT "rate_entries_rate_table_id_rate_tables_id_fkey" FOREIGN KEY ("rate_table_id") REFERENCES "rate_tables"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "rate_entries" ADD CONSTRAINT "rate_entries_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "rate_tables" ADD CONSTRAINT "rate_tables_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "rate_tables" ADD CONSTRAINT "rate_tables_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_entity_id_entities_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_entity_id_entities_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "template_categories" ADD CONSTRAINT "template_categories_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "template_categories" ADD CONSTRAINT "template_categories_parent_id_template_categories_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "template_categories"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "template_clauses" ADD CONSTRAINT "template_clauses_clause_id_clauses_id_fkey" FOREIGN KEY ("clause_id") REFERENCES "clauses"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "template_clauses" ADD CONSTRAINT "template_clauses_clause_variant_id_clause_variants_id_fkey" FOREIGN KEY ("clause_variant_id") REFERENCES "clause_variants"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "template_clauses" ADD CONSTRAINT "template_clauses_clause_version_id_clause_versions_id_fkey" FOREIGN KEY ("clause_version_id") REFERENCES "clause_versions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "template_clauses" ADD CONSTRAINT "template_clauses_1frtsdpERNAO_fkey" FOREIGN KEY ("template_id","organization_id") REFERENCES "templates"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "template_fills" ADD CONSTRAINT "template_fills_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "template_fills" ADD CONSTRAINT "template_fills_template_id_templates_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "template_fills" ADD CONSTRAINT "template_fills_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_Dki90WgaVz8z_fkey" FOREIGN KEY ("template_id","organization_id") REFERENCES "templates"("id","organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_category_id_template_categories_id_fkey" FOREIGN KEY ("category_id") REFERENCES "template_categories"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_matter_id_entities_id_fkey" FOREIGN KEY ("matter_id") REFERENCES "entities"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_invoice_id_invoices_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "user_files" ADD CONSTRAINT "user_files_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_files" ADD CONSTRAINT "user_files_thread_id_chat_threads_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "chat_threads"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "workspace_contacts" ADD CONSTRAINT "workspace_contacts_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_contacts" ADD CONSTRAINT "workspace_contacts_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_contacts" ADD CONSTRAINT "workspace_contacts_contact_id_contacts_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_views" ADD CONSTRAINT "workspace_views_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_client_id_contacts_id_fkey" FOREIGN KEY ("client_id") REFERENCES "contacts"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_refresh_id_oauth_refresh_token_id_fkey" FOREIGN KEY ("refresh_id") REFERENCES "oauth_refresh_token"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "audit_logs_select" ON "audit_logs" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "audit_logs_insert" ON "audit_logs" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "billing_codes" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "billing_codes" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "billing_codes" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "billing_codes" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "case_law_matter_links" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "case_law_matter_links" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "case_law_matter_links" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "case_law_matter_links" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "chat_select" ON "chat_messages" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  user_id =
  (SELECT current_setting(
    'app.user_id', true
  )) AND
  (workspace_id IS NULL OR workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]))
));--> statement-breakpoint
CREATE POLICY "chat_insert" ON "chat_messages" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  user_id =
  (SELECT current_setting(
    'app.user_id', true
  )) AND
  (workspace_id IS NULL OR workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]))
));--> statement-breakpoint
CREATE POLICY "chat_update" ON "chat_messages" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
  user_id =
  (SELECT current_setting(
    'app.user_id', true
  )) AND
  (workspace_id IS NULL OR workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]))
));--> statement-breakpoint
CREATE POLICY "chat_delete" ON "chat_messages" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  user_id =
  (SELECT current_setting(
    'app.user_id', true
  )) AND
  (workspace_id IS NULL OR workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]))
));--> statement-breakpoint
CREATE POLICY "chat_select" ON "chat_threads" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  user_id =
  (SELECT current_setting(
    'app.user_id', true
  )) AND
  (workspace_id IS NULL OR workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]))
));--> statement-breakpoint
CREATE POLICY "chat_insert" ON "chat_threads" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  user_id =
  (SELECT current_setting(
    'app.user_id', true
  )) AND
  (workspace_id IS NULL OR workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]))
));--> statement-breakpoint
CREATE POLICY "chat_update" ON "chat_threads" AS PERMISSIVE FOR UPDATE TO "stella" USING ((
  user_id =
  (SELECT current_setting(
    'app.user_id', true
  )) AND
  (workspace_id IS NULL OR workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]))
));--> statement-breakpoint
CREATE POLICY "chat_delete" ON "chat_threads" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  user_id =
  (SELECT current_setting(
    'app.user_id', true
  )) AND
  (workspace_id IS NULL OR workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]))
));--> statement-breakpoint
CREATE POLICY "organization_select" ON "clause_categories" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "clause_categories" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_update" ON "clause_categories" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "clause_categories" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_select" ON "clause_variants" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "clause_variants" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_update" ON "clause_variants" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "clause_variants" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_select" ON "clause_versions" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "clause_versions" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_update" ON "clause_versions" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "clause_versions" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_select" ON "clauses" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "clauses" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_update" ON "clauses" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "clauses" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_select" ON "contact_relationships" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "contact_relationships" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_update" ON "contact_relationships" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "contact_relationships" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_select" ON "contacts" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "contacts" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_update" ON "contacts" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "contacts" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "desktop_edit_sessions" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "desktop_edit_sessions" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "desktop_edit_sessions" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "desktop_edit_sessions" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "document_counters" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "document_counters" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "document_counters" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "document_counters" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "entities" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "entities" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "entities" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "entities" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "entity_links" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "entity_links" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "entity_links" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "entity_links" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "entity_version_ai_summaries" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "entity_version_ai_summaries" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "entity_version_ai_summaries" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "entity_version_ai_summaries" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "entity_versions" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "entity_versions" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "entity_versions" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "entity_versions" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "expenses" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "expenses" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "expenses" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "expenses" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "fields" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "fields" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "fields" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "fields" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "invoices" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "invoices" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "invoices" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "invoices" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "justifications" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "justifications" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "justifications" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "justifications" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "organization_select" ON "matter_counters" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "matter_counters" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_update" ON "matter_counters" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "matter_counters" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_select" ON "organization_settings" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "organization_settings" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_update" ON "organization_settings" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "organization_settings" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "properties" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "properties" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "properties" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "properties" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "property_dependencies" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "property_dependencies" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "property_dependencies" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "property_dependencies" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "rate_entries" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "rate_entries" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "rate_entries" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "rate_entries" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "rate_tables" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "rate_tables" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "rate_tables" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "rate_tables" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "task_assignees" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "task_assignees" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "task_assignees" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "task_assignees" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "organization_select" ON "template_categories" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "template_categories" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_update" ON "template_categories" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "template_categories" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_select" ON "template_clauses" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "template_clauses" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_update" ON "template_clauses" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "template_clauses" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_select" ON "template_fills" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "template_fills" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_update" ON "template_fills" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "template_fills" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_select" ON "template_versions" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "template_versions" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_update" ON "template_versions" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "template_versions" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_select" ON "templates" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "templates" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_update" ON "templates" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "templates" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "time_entries" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "time_entries" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "time_entries" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "time_entries" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "user_select" ON "user_files" AS PERMISSIVE FOR SELECT TO "stella" USING (user_id =
  (SELECT current_setting(
    'app.user_id', true
  )));--> statement-breakpoint
CREATE POLICY "user_insert" ON "user_files" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (user_id =
  (SELECT current_setting(
    'app.user_id', true
  )));--> statement-breakpoint
CREATE POLICY "user_update" ON "user_files" AS PERMISSIVE FOR UPDATE TO "stella" USING (user_id =
  (SELECT current_setting(
    'app.user_id', true
  )));--> statement-breakpoint
CREATE POLICY "user_delete" ON "user_files" AS PERMISSIVE FOR DELETE TO "stella" USING (user_id =
  (SELECT current_setting(
    'app.user_id', true
  )));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "workspace_contacts" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "workspace_contacts" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "workspace_contacts" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "workspace_contacts" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "workspace_members" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "workspace_members" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "workspace_members" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "workspace_members" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "workspace_views" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "workspace_views" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "workspace_views" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "workspace_views" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "workspaces" AS PERMISSIVE FOR SELECT TO "stella" USING (id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "workspaces" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "workspaces" AS PERMISSIVE FOR UPDATE TO "stella" USING (id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "workspaces" AS PERMISSIVE FOR DELETE TO "stella" USING (id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
