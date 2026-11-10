SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Who produces a generation run, and what a run stella produces needs to be
-- claimed by a worker. Every existing run was submitted by an external
-- client, which the constant default records without rewriting rows. The
-- checks only constrain the new columns and are validated online after
-- deployment (list-generation-constraint-validation.ts).
ALTER TABLE "legal_list_generation_runs" ADD COLUMN "producer" text DEFAULT 'external' NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_list_generation_runs" ADD COLUMN "organization_id" varchar(128);--> statement-breakpoint
ALTER TABLE "legal_list_generation_runs" ADD COLUMN "item_type" text;--> statement-breakpoint
ALTER TABLE "legal_list_generation_runs" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "legal_list_generation_runs" ADD COLUMN "started_at" timestamptz;--> statement-breakpoint
ALTER TABLE "legal_list_generation_runs" ADD CONSTRAINT "legal_list_generation_runs_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces"("id", "organization_id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "legal_list_generation_runs" ADD CONSTRAINT "legal_list_generation_runs_producer_check" CHECK ("producer" in ('external', 'stella')) NOT VALID;--> statement-breakpoint
ALTER TABLE "legal_list_generation_runs" ADD CONSTRAINT "legal_list_generation_runs_item_type_check" CHECK ("item_type" is null or "item_type" in ('task', 'fact', 'issue', 'requirement', 'event')) NOT VALID;--> statement-breakpoint
ALTER TABLE "legal_list_generation_runs" ADD CONSTRAINT "legal_list_generation_runs_stella_shape_check" CHECK ("producer" = 'external' or ("organization_id" is not null and "item_type" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "legal_list_generation_runs" ADD CONSTRAINT "legal_list_generation_runs_error_code_check" CHECK (("error_code" is null or ("status" = 'failed' and "error_code" in ('source_unavailable', 'unsupported_format', 'no_text', 'ai_unavailable', 'extraction_failed', 'enqueue_failed', 'access_revoked', 'run_limit_reached', 'internal'))) and ("producer" = 'external' or ("status" = 'failed') = ("error_code" is not null))) NOT VALID;--> statement-breakpoint

-- A run that records its organization is pinned to it as well as to its
-- workspace; a run written before the column carries none and keeps its
-- workspace pin, so its history and pending candidates stay reachable.
-- stella-migration-safety: reviewed alter-policy - the run now records its organization; a row that records one must match the session organization and the workspace pin is unchanged, so access only narrows
ALTER POLICY "workspace_select" ON "legal_list_generation_runs" USING ((CASE
  WHEN workspace_id = ANY(
    COALESCE(
      NULLIF(
        (SELECT pg_catalog.current_setting(
          'app.workspace_ids', true
        )),
        ''
      )::uuid[],
      ARRAY[]::uuid[]
    )
  )
  THEN true
  ELSE workspace_id IN (
    SELECT aw.authorized_workspace_id
    FROM public.stella_authorized_workspaces aw
  )
END) AND (organization_id IS NULL OR organization_id = (SELECT current_setting(
  'app.organization_id', true
))));--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - the run now records its organization; a row that records one must match the session organization and the workspace pin is unchanged, so access only narrows
ALTER POLICY "workspace_insert" ON "legal_list_generation_runs" WITH CHECK ((CASE
  WHEN workspace_id = ANY(
    COALESCE(
      NULLIF(
        (SELECT pg_catalog.current_setting(
          'app.workspace_ids', true
        )),
        ''
      )::uuid[],
      ARRAY[]::uuid[]
    )
  )
  THEN true
  ELSE workspace_id IN (
    SELECT aw.authorized_workspace_id
    FROM public.stella_authorized_workspaces aw
  )
END) AND organization_id = (SELECT current_setting(
  'app.organization_id', true
)));--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - the run now records its organization; a row that records one must match the session organization and the workspace pin is unchanged, so access only narrows
ALTER POLICY "workspace_update" ON "legal_list_generation_runs" USING ((CASE
  WHEN workspace_id = ANY(
    COALESCE(
      NULLIF(
        (SELECT pg_catalog.current_setting(
          'app.workspace_ids', true
        )),
        ''
      )::uuid[],
      ARRAY[]::uuid[]
    )
  )
  THEN true
  ELSE workspace_id IN (
    SELECT aw.authorized_workspace_id
    FROM public.stella_authorized_workspaces aw
  )
END) AND (organization_id IS NULL OR organization_id = (SELECT current_setting(
  'app.organization_id', true
))));--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - the run now records its organization; a row that records one must match the session organization and the workspace pin is unchanged, so access only narrows
ALTER POLICY "workspace_delete" ON "legal_list_generation_runs" USING ((CASE
  WHEN workspace_id = ANY(
    COALESCE(
      NULLIF(
        (SELECT pg_catalog.current_setting(
          'app.workspace_ids', true
        )),
        ''
      )::uuid[],
      ARRAY[]::uuid[]
    )
  )
  THEN true
  ELSE workspace_id IN (
    SELECT aw.authorized_workspace_id
    FROM public.stella_authorized_workspaces aw
  )
END) AND (organization_id IS NULL OR organization_id = (SELECT current_setting(
  'app.organization_id', true
))));--> statement-breakpoint

-- The fact details a fact candidate proposes, with the checks
-- legal_list_fact_details carries, so acceptance copies a valid row.
ALTER TABLE "legal_list_generation_candidates" ADD COLUMN "occurred_on" date;--> statement-breakpoint
ALTER TABLE "legal_list_generation_candidates" ADD COLUMN "occurred_on_precision" text;--> statement-breakpoint
ALTER TABLE "legal_list_generation_candidates" ADD COLUMN "evidence_kind" varchar(64);--> statement-breakpoint
ALTER TABLE "legal_list_generation_candidates" ADD COLUMN "medium" varchar(64);--> statement-breakpoint
ALTER TABLE "legal_list_generation_candidates" ADD COLUMN "confidence" text;--> statement-breakpoint
ALTER TABLE "legal_list_generation_candidates" ADD COLUMN "interpretation_note" varchar(4000);--> statement-breakpoint
ALTER TABLE "legal_list_generation_candidates" ADD COLUMN "scoring" text;--> statement-breakpoint
ALTER TABLE "legal_list_generation_candidates" ADD CONSTRAINT "legal_list_generation_candidates_confidence_check" CHECK ("confidence" in ('high', 'medium', 'low')) NOT VALID;--> statement-breakpoint
ALTER TABLE "legal_list_generation_candidates" ADD CONSTRAINT "legal_list_generation_candidates_scoring_check" CHECK ("scoring" in ('included', 'held')) NOT VALID;--> statement-breakpoint
ALTER TABLE "legal_list_generation_candidates" ADD CONSTRAINT "legal_list_generation_candidates_occurred_on_canonical_check" CHECK ("occurred_on_precision" is null or "occurred_on_precision" = 'day' or (extract(day from "occurred_on") = 1 and ("occurred_on_precision" = 'month' or extract(month from "occurred_on") = 1))) NOT VALID;--> statement-breakpoint
ALTER TABLE "legal_list_generation_candidates" ADD CONSTRAINT "legal_list_generation_candidates_occurred_on_check" CHECK (("occurred_on" is null) = ("occurred_on_precision" is null) and ("occurred_on_precision" is null or "occurred_on_precision" in ('day', 'month', 'year'))) NOT VALID;--> statement-breakpoint
ALTER TABLE "legal_list_generation_candidates" ADD CONSTRAINT "legal_list_generation_candidates_fact_details_check" CHECK ("item_type" = 'fact' or ("occurred_on" is null and "evidence_kind" is null and "medium" is null and "confidence" is null and "interpretation_note" is null and "scoring" is null)) NOT VALID;
