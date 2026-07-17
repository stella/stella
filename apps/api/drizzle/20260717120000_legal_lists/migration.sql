SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- Additive first release: legacy task rows and APIs remain valid while Lists
-- are introduced as explicit matter-scoped resources. Existing tasks are
-- attached by the bounded backfill job, not by this schema transaction.
CREATE TABLE "legal_lists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(256) NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "legal_lists_id_ws_unq" UNIQUE("id", "workspace_id")
);--> statement-breakpoint

CREATE TABLE "legal_list_sections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"list_id" uuid NOT NULL,
	"name" varchar(256) NOT NULL,
	"position" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "legal_list_sections_id_list_ws_unq" UNIQUE("id", "list_id", "workspace_id")
);--> statement-breakpoint

CREATE TABLE "legal_list_columns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"list_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "legal_list_items" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"list_id" uuid NOT NULL,
	"section_id" uuid,
	"position" varchar(64) NOT NULL,
	"description" text,
	"review_status" text DEFAULT 'unreviewed' NOT NULL,
	"added_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "legal_list_items_entity_list_ws_unq" UNIQUE("entity_id", "list_id", "workspace_id")
);--> statement-breakpoint

CREATE TABLE "legal_list_item_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"list_id" uuid NOT NULL,
	"item_entity_id" uuid NOT NULL,
	"source_entity_id" uuid NOT NULL,
	"source_entity_version_id" uuid NOT NULL,
	"locator" jsonb NOT NULL,
	"quote" text,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"verified_by" text,
	"verified_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "legal_list_generation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"list_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"instruction" varchar(4000) NOT NULL,
	"requested_by" text,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "legal_list_generation_runs_id_list_ws_unq" UNIQUE("id", "list_id", "workspace_id")
);--> statement-breakpoint

CREATE TABLE "legal_list_generation_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"list_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source_entity_id" uuid NOT NULL,
	"source_entity_version_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "legal_list_generation_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"list_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" varchar(2000) NOT NULL,
	"description" text,
	"item_type" text NOT NULL,
	"item_status" varchar(32),
	"priority" varchar(16),
	"due_date" date,
	"suggested_assignee_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"accepted_entity_id" uuid,
	"reserved_entity_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "legal_list_generation_candidate_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"list_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"source_entity_id" uuid NOT NULL,
	"source_entity_version_id" uuid NOT NULL,
	"locator" jsonb NOT NULL,
	"quote" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "legal_list_item_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"list_id" uuid NOT NULL,
	"item_entity_id" uuid NOT NULL,
	"body" varchar(10000) NOT NULL,
	"author_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "legal_list_item_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"list_id" uuid NOT NULL,
	"item_entity_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"note" varchar(10000),
	"reviewer_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "legal_lists" ADD CONSTRAINT "legal_lists_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_lists" ADD CONSTRAINT "legal_lists_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "legal_list_sections" ADD CONSTRAINT "legal_list_sections_list_fk" FOREIGN KEY ("list_id", "workspace_id") REFERENCES "legal_lists"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_list_columns" ADD CONSTRAINT "legal_list_columns_list_fk" FOREIGN KEY ("list_id", "workspace_id") REFERENCES "legal_lists"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_list_columns" ADD CONSTRAINT "legal_list_columns_property_fk" FOREIGN KEY ("property_id", "workspace_id") REFERENCES "properties"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_list_items" ADD CONSTRAINT "legal_list_items_entity_fk" FOREIGN KEY ("entity_id", "workspace_id") REFERENCES "entities"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_list_items" ADD CONSTRAINT "legal_list_items_list_fk" FOREIGN KEY ("list_id", "workspace_id") REFERENCES "legal_lists"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_list_items" ADD CONSTRAINT "legal_list_items_section_fk" FOREIGN KEY ("section_id", "list_id", "workspace_id") REFERENCES "legal_list_sections"("id", "list_id", "workspace_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "legal_list_items" ADD CONSTRAINT "legal_list_items_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "legal_list_item_sources" ADD CONSTRAINT "legal_list_item_sources_item_fk" FOREIGN KEY ("item_entity_id", "list_id", "workspace_id") REFERENCES "legal_list_items"("entity_id", "list_id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_list_item_sources" ADD CONSTRAINT "legal_list_item_sources_source_entity_fk" FOREIGN KEY ("source_entity_id", "workspace_id") REFERENCES "entities"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_list_item_sources" ADD CONSTRAINT "legal_list_item_sources_source_entity_version_id_entity_versions_id_fk" FOREIGN KEY ("source_entity_version_id") REFERENCES "entity_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_list_item_sources" ADD CONSTRAINT "legal_list_item_sources_verified_by_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "legal_list_item_sources" ADD CONSTRAINT "legal_list_item_sources_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "legal_list_generation_runs" ADD CONSTRAINT "legal_list_generation_runs_list_fk" FOREIGN KEY ("list_id", "workspace_id") REFERENCES "legal_lists"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_list_generation_runs" ADD CONSTRAINT "legal_list_generation_runs_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "legal_list_generation_sources" ADD CONSTRAINT "legal_list_generation_sources_run_fk" FOREIGN KEY ("run_id", "list_id", "workspace_id") REFERENCES "legal_list_generation_runs"("id", "list_id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_list_generation_sources" ADD CONSTRAINT "legal_list_generation_sources_entity_fk" FOREIGN KEY ("source_entity_id", "workspace_id") REFERENCES "entities"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_list_generation_sources" ADD CONSTRAINT "legal_list_generation_sources_source_entity_version_id_entity_versions_id_fk" FOREIGN KEY ("source_entity_version_id") REFERENCES "entity_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_list_generation_candidates" ADD CONSTRAINT "legal_list_generation_candidates_run_fk" FOREIGN KEY ("run_id", "list_id", "workspace_id") REFERENCES "legal_list_generation_runs"("id", "list_id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_list_generation_candidates" ADD CONSTRAINT "legal_list_generation_candidates_accepted_entity_id_entities_id_fk" FOREIGN KEY ("accepted_entity_id") REFERENCES "entities"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "legal_list_generation_candidate_sources" ADD CONSTRAINT "legal_list_candidate_sources_candidate_fk" FOREIGN KEY ("candidate_id") REFERENCES "legal_list_generation_candidates"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_list_generation_candidate_sources" ADD CONSTRAINT "legal_list_candidate_sources_run_fk" FOREIGN KEY ("run_id", "list_id", "workspace_id") REFERENCES "legal_list_generation_runs"("id", "list_id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_list_generation_candidate_sources" ADD CONSTRAINT "legal_list_candidate_sources_entity_fk" FOREIGN KEY ("source_entity_id", "workspace_id") REFERENCES "entities"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_list_generation_candidate_sources" ADD CONSTRAINT "legal_list_generation_candidate_sources_source_entity_version_id_entity_versions_id_fk" FOREIGN KEY ("source_entity_version_id") REFERENCES "entity_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_list_item_comments" ADD CONSTRAINT "legal_list_item_comments_item_fk" FOREIGN KEY ("item_entity_id", "list_id", "workspace_id") REFERENCES "legal_list_items"("entity_id", "list_id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_list_item_comments" ADD CONSTRAINT "legal_list_item_comments_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "legal_list_item_reviews" ADD CONSTRAINT "legal_list_item_reviews_item_fk" FOREIGN KEY ("item_entity_id", "list_id", "workspace_id") REFERENCES "legal_list_items"("entity_id", "list_id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_list_item_reviews" ADD CONSTRAINT "legal_list_item_reviews_reviewer_id_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint

CREATE INDEX "legal_lists_workspace_status_created_idx" ON "legal_lists" ("workspace_id", "status", "created_at", "id");--> statement-breakpoint
CREATE INDEX "legal_list_sections_list_position_idx" ON "legal_list_sections" ("workspace_id", "list_id", "position", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_list_columns_list_property_uidx" ON "legal_list_columns" ("list_id", "property_id");--> statement-breakpoint
CREATE INDEX "legal_list_columns_list_position_idx" ON "legal_list_columns" ("workspace_id", "list_id", "position", "id");--> statement-breakpoint
CREATE INDEX "legal_list_items_list_section_position_idx" ON "legal_list_items" ("workspace_id", "list_id", "section_id", "position", "entity_id");--> statement-breakpoint
CREATE INDEX "legal_list_items_list_review_idx" ON "legal_list_items" ("workspace_id", "list_id", "review_status", "entity_id");--> statement-breakpoint
CREATE INDEX "legal_list_item_sources_item_created_idx" ON "legal_list_item_sources" ("workspace_id", "item_entity_id", "created_at", "id");--> statement-breakpoint
CREATE INDEX "legal_list_item_sources_source_version_idx" ON "legal_list_item_sources" ("workspace_id", "source_entity_version_id", "id");--> statement-breakpoint
CREATE INDEX "legal_list_generation_runs_list_created_idx" ON "legal_list_generation_runs" ("workspace_id", "list_id", "created_at", "id");--> statement-breakpoint
CREATE INDEX "legal_list_generation_runs_status_idx" ON "legal_list_generation_runs" ("workspace_id", "status", "created_at", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_list_generation_sources_run_entity_uidx" ON "legal_list_generation_sources" ("run_id", "source_entity_id");--> statement-breakpoint
CREATE INDEX "legal_list_generation_sources_run_idx" ON "legal_list_generation_sources" ("workspace_id", "run_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_list_generation_candidates_run_position_uidx" ON "legal_list_generation_candidates" ("run_id", "position");--> statement-breakpoint
CREATE INDEX "legal_list_generation_candidates_run_status_idx" ON "legal_list_generation_candidates" ("workspace_id", "run_id", "status", "position", "id");--> statement-breakpoint
CREATE INDEX "legal_list_generation_candidate_sources_candidate_idx" ON "legal_list_generation_candidate_sources" ("workspace_id", "candidate_id", "id");--> statement-breakpoint
CREATE INDEX "legal_list_item_comments_item_created_idx" ON "legal_list_item_comments" ("workspace_id", "item_entity_id", "created_at", "id");--> statement-breakpoint
CREATE INDEX "legal_list_item_reviews_item_created_idx" ON "legal_list_item_reviews" ("workspace_id", "item_entity_id", "created_at", "id");--> statement-breakpoint

DO $$
DECLARE
	table_name text;
	workspace_access text := $predicate$
		CASE
			WHEN workspace_id = ANY(
				COALESCE(
					NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[],
					ARRAY[]::uuid[]
				)
			)
			THEN true
			ELSE workspace_id IN (
				SELECT aw.authorized_workspace_id
				FROM public.stella_authorized_workspaces aw
			)
		END
	$predicate$;
BEGIN
	FOREACH table_name IN ARRAY ARRAY[
		'legal_lists',
		'legal_list_sections',
		'legal_list_columns',
		'legal_list_items',
		'legal_list_item_sources',
		'legal_list_generation_runs',
		'legal_list_generation_sources',
		'legal_list_generation_candidates',
		'legal_list_generation_candidate_sources',
		'legal_list_item_comments',
		'legal_list_item_reviews'
	]
	LOOP
		EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
		EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO stella', table_name);
		EXECUTE format('CREATE POLICY workspace_select ON %I AS PERMISSIVE FOR SELECT TO stella USING (%s)', table_name, workspace_access);
		EXECUTE format('CREATE POLICY workspace_insert ON %I AS PERMISSIVE FOR INSERT TO stella WITH CHECK (%s)', table_name, workspace_access);
		EXECUTE format('CREATE POLICY workspace_update ON %I AS PERMISSIVE FOR UPDATE TO stella USING (%s)', table_name, workspace_access);
		EXECUTE format('CREATE POLICY workspace_delete ON %I AS PERMISSIVE FOR DELETE TO stella USING (%s)', table_name, workspace_access);
	END LOOP;
END
$$;
