SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- Evidential detail of a fact item, and verifications of a document against
-- a list's facts. All four tables are new, so nothing here touches live rows.
CREATE TABLE "legal_list_fact_details" (
	"item_entity_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"list_id" uuid NOT NULL,
	"occurred_on" date,
	"occurred_on_precision" text,
	"evidence_kind" varchar(64),
	"medium" varchar(64),
	"confidence" text NOT NULL,
	"interpretation_note" varchar(4000),
	"scoring" text DEFAULT 'included' NOT NULL,
	"updated_by" text,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "legal_list_fact_details_confidence_check" CHECK ("confidence" in ('high', 'medium', 'low')),
	CONSTRAINT "legal_list_fact_details_scoring_check" CHECK ("scoring" in ('included', 'held')),
	CONSTRAINT "legal_list_fact_details_occurred_on_canonical_check" CHECK ("occurred_on_precision" is null or "occurred_on_precision" = 'day' or (extract(day from "occurred_on") = 1 and ("occurred_on_precision" = 'month' or extract(month from "occurred_on") = 1))),
	CONSTRAINT "legal_list_fact_details_occurred_on_check" CHECK (("occurred_on" is null) = ("occurred_on_precision" is null) and ("occurred_on_precision" is null or "occurred_on_precision" in ('day', 'month', 'year'))),
	CONSTRAINT "legal_list_fact_details_item_fk" FOREIGN KEY ("item_entity_id", "list_id", "workspace_id") REFERENCES "legal_list_items"("entity_id", "list_id", "workspace_id") ON DELETE CASCADE,
	CONSTRAINT "legal_list_fact_details_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE SET NULL
);--> statement-breakpoint
CREATE INDEX "legal_list_fact_details_list_idx" ON "legal_list_fact_details" ("workspace_id", "list_id", "item_entity_id");--> statement-breakpoint

CREATE TABLE "legal_list_verification_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"file_field_id" uuid NOT NULL,
	"entity_version_id" uuid NOT NULL,
	"content_sha256" varchar(64) NOT NULL,
	"evidence" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"requested_by" text,
	"pipeline_version" integer DEFAULT 1 NOT NULL,
	"model_ref" varchar(256),
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"started_at" timestamptz,
	"finished_at" timestamptz,
	CONSTRAINT "legal_list_verification_runs_id_ws_unq" UNIQUE ("id", "workspace_id"),
	CONSTRAINT "legal_list_verification_runs_status_check" CHECK ("status" IN ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "legal_list_verification_runs_error_code_check" CHECK (("status" = 'failed') = ("error_code" IS NOT NULL)
        AND ("error_code" IS NULL OR "error_code" IN ('pin_unresolved', 'pin_content_changed', 'unsupported_format', 'no_text', 'ai_unavailable', 'extraction_failed', 'grading_failed', 'enqueue_failed', 'internal'))),
	CONSTRAINT "legal_list_verification_runs_content_hash_check" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "legal_list_verification_runs_evidence_shape_check" CHECK (jsonb_typeof("evidence"->'facts') = 'array'
        AND jsonb_typeof("evidence"->'listId') = 'string'),
	CONSTRAINT "legal_list_verification_runs_pipeline_version_check" CHECK ("pipeline_version" > 0),
	CONSTRAINT "legal_list_verification_runs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE,
	CONSTRAINT "legal_list_verification_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
	CONSTRAINT "legal_list_verification_runs_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "user"("id") ON DELETE SET NULL,
	CONSTRAINT "legal_list_verification_runs_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces"("id", "organization_id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "legal_list_verification_runs_document_created_idx" ON "legal_list_verification_runs" ("workspace_id", "entity_id", "file_field_id", "created_at" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "legal_list_verification_runs_queued_idx" ON "legal_list_verification_runs" ("created_at", "id") WHERE "status" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "legal_list_verification_runs_active_document_uidx" ON "legal_list_verification_runs" ("workspace_id", "entity_id", "file_field_id") WHERE "status" IN ('queued', 'running');--> statement-breakpoint

CREATE TABLE "legal_list_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"type" text NOT NULL,
	"framing" text DEFAULT 'asserted' NOT NULL,
	"state" text NOT NULL,
	"score" smallint,
	"text" varchar(4000) NOT NULL,
	"anchor" jsonb NOT NULL,
	"refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"record_conflict" jsonb,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "legal_list_claims_id_run_ws_unq" UNIQUE ("id", "run_id", "workspace_id"),
	CONSTRAINT "legal_list_claims_type_check" CHECK ("type" IN ('fact', 'opinion', 'unverifiable')),
	CONSTRAINT "legal_list_claims_framing_check" CHECK ("framing" IN ('asserted', 'recalled')),
	CONSTRAINT "legal_list_claims_state_check" CHECK ("state" IN ('supported', 'tension', 'contradicted', 'nocover', 'notverifiable', 'recordconflict')),
	CONSTRAINT "legal_list_claims_score_check" CHECK (("state" IN ('supported', 'tension', 'contradicted')) = ("score" IS NOT NULL)
        AND ("score" IS NULL OR "score" BETWEEN 0 AND 100)),
	CONSTRAINT "legal_list_claims_type_state_check" CHECK (("type" = 'fact') = ("state" <> 'notverifiable')),
	CONSTRAINT "legal_list_claims_record_conflict_check" CHECK (("state" = 'recordconflict') = ("record_conflict" IS NOT NULL)),
	CONSTRAINT "legal_list_claims_refs_shape_check" CHECK (jsonb_typeof("refs") = 'array'),
	CONSTRAINT "legal_list_claims_anchor_shape_check" CHECK ("anchor"->>'type' IN ('docx-block', 'pdf-page')),
	CONSTRAINT "legal_list_claims_position_check" CHECK ("position" >= 0 AND "position" < 2000),
	CONSTRAINT "legal_list_claims_run_fk" FOREIGN KEY ("run_id", "workspace_id") REFERENCES "legal_list_verification_runs"("id", "workspace_id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE UNIQUE INDEX "legal_list_claims_run_position_uidx" ON "legal_list_claims" ("run_id", "position");--> statement-breakpoint
CREATE INDEX "legal_list_claims_run_idx" ON "legal_list_claims" ("workspace_id", "run_id", "position");--> statement-breakpoint

CREATE TABLE "legal_list_claim_review_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"actor_id" text,
	"created_at" timestamptz DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "legal_list_claim_review_events_kind_check" CHECK ("kind" IN ('status', 'override', 'note', 'reopen', 'record-conflict')),
	CONSTRAINT "legal_list_claim_review_events_payload_kind_check" CHECK ("payload"->>'kind' = "kind"),
	CONSTRAINT "legal_list_claim_review_events_claim_fk" FOREIGN KEY ("claim_id", "run_id", "workspace_id") REFERENCES "legal_list_claims"("id", "run_id", "workspace_id") ON DELETE CASCADE,
	CONSTRAINT "legal_list_claim_review_events_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE SET NULL
);--> statement-breakpoint
CREATE INDEX "legal_list_claim_review_events_run_created_idx" ON "legal_list_claim_review_events" ("workspace_id", "run_id", "created_at", "id");--> statement-breakpoint

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
		'legal_list_fact_details',
		'legal_list_claims',
		'legal_list_claim_review_events'
	]
	LOOP
		EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
		EXECUTE format('CREATE POLICY workspace_select ON %I AS PERMISSIVE FOR SELECT TO stella USING (%s)', table_name, workspace_access);
		EXECUTE format('CREATE POLICY workspace_insert ON %I AS PERMISSIVE FOR INSERT TO stella WITH CHECK (%s)', table_name, workspace_access);
		IF table_name = 'legal_list_claim_review_events' THEN
			EXECUTE format('GRANT SELECT, INSERT ON TABLE %I TO stella', table_name);
		ELSE
			EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO stella', table_name);
			EXECUTE format('CREATE POLICY workspace_update ON %I AS PERMISSIVE FOR UPDATE TO stella USING (%s)', table_name, workspace_access);
			EXECUTE format('CREATE POLICY workspace_delete ON %I AS PERMISSIVE FOR DELETE TO stella USING (%s)', table_name, workspace_access);
		END IF;
	END LOOP;
END
$$;--> statement-breakpoint

-- A run carries both scopes, and the worker rebuilds its tenant from the row,
-- so every command requires the workspace and the organization together.
DO $$
DECLARE
	scope text := $predicate$
		(CASE
			WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
			THEN true
			ELSE workspace_id IN (
				SELECT aw.authorized_workspace_id
				FROM public.stella_authorized_workspaces aw
			)
		END) AND organization_id = (SELECT current_setting('app.organization_id', true))
	$predicate$;
BEGIN
	ALTER TABLE "legal_list_verification_runs" ENABLE ROW LEVEL SECURITY;
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "legal_list_verification_runs" TO stella;
	EXECUTE format('CREATE POLICY legal_list_verification_runs_workspace_select ON "legal_list_verification_runs" AS PERMISSIVE FOR SELECT TO stella USING (%s)', scope);
	EXECUTE format('CREATE POLICY legal_list_verification_runs_workspace_insert ON "legal_list_verification_runs" AS PERMISSIVE FOR INSERT TO stella WITH CHECK (%s)', scope);
	EXECUTE format('CREATE POLICY legal_list_verification_runs_workspace_update ON "legal_list_verification_runs" AS PERMISSIVE FOR UPDATE TO stella USING (%s)', scope);
	EXECUTE format('CREATE POLICY legal_list_verification_runs_workspace_delete ON "legal_list_verification_runs" AS PERMISSIVE FOR DELETE TO stella USING (%s)', scope);
END
$$;--> statement-breakpoint

-- Review history is append-only: a reviewer's action is never rewritten.
CREATE POLICY legal_list_claim_review_events_no_update ON "legal_list_claim_review_events" AS RESTRICTIVE FOR UPDATE TO stella USING (false);--> statement-breakpoint
CREATE POLICY legal_list_claim_review_events_no_delete ON "legal_list_claim_review_events" AS RESTRICTIVE FOR DELETE TO stella USING (false);
