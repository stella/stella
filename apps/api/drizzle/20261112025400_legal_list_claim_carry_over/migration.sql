-- requires: 20261111184500_legal_list_claim_rechecks
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- Review decisions follow a claim to the next run of its document. A carried
-- event is a new row on the new run's claim that names the run and event it
-- copies; both columns are new and NULL for every stored row, so adding them
-- rewrites nothing.
--
-- The reason check is dropped by name and re-added, in the same statement,
-- widened by one case: a carried copy of an event recorded before reasons
-- were required keeps its payload as written, without the reason its kind now
-- requires. Every row the old check admits, the new one admits too. Both
-- checks are added NOT VALID: no stored row is scanned under the lock, the
-- reason check stays unvalidated on purpose (see
-- 20261111120000_legal_list_claim_review_reasons), and every stored row has
-- both new columns NULL, which the pairing check admits.
-- stella-migration-safety: reviewed drop-constraint - drops only the reason check by name and re-adds it, widened to carried copies, in the same statement; no row data is touched. Rollback is the same statement with the previous expression, safe once no carried row lacks a required reason.
ALTER TABLE "legal_list_claim_review_events"
  ADD COLUMN "carried_from_run_id" uuid,
  ADD COLUMN "carried_from_event_id" uuid,
  ADD CONSTRAINT "legal_list_claim_review_events_carried_from_check"
  CHECK (("carried_from_run_id" IS NULL) = ("carried_from_event_id" IS NULL)) NOT VALID,
  DROP CONSTRAINT IF EXISTS "legal_list_claim_review_events_reason_check",
  ADD CONSTRAINT "legal_list_claim_review_events_reason_check"
  CHECK (CASE WHEN "payload"->'reason' IS NULL
    THEN "kind" NOT IN ('override', 'reopen', 'record-conflict')
      OR "carried_from_event_id" IS NOT NULL
    ELSE "kind" IN ('status', 'override', 'reopen', 'record-conflict', 'fact-link')
      AND jsonb_typeof("payload"->'reason') = 'string'
      AND char_length(btrim("payload"->>'reason')) BETWEEN 1 AND 10000
    END) NOT VALID;--> statement-breakpoint

-- What became of each reviewed claim of the previous run when the next run
-- completed. A new, empty table, written only by run completion.
CREATE TABLE "legal_list_claim_carry_outcomes" (
  "entity_feature_gate" text DEFAULT 'pending' NOT NULL,
  "entity_feature_organization_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  "workspace_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "source_run_id" uuid NOT NULL,
  "source_claim_id" uuid NOT NULL,
  "outcome" text NOT NULL,
  "target_claim_id" uuid,
  CONSTRAINT "legal_list_claim_carry_outcomes_pkey" PRIMARY KEY ("run_id", "source_claim_id"),
  CONSTRAINT "legal_list_claim_carry_outcomes_target_unq" UNIQUE ("run_id", "target_claim_id"),
  CONSTRAINT "legal_list_claim_carry_outcomes_run_fk" FOREIGN KEY ("run_id", "workspace_id") REFERENCES "legal_list_verification_runs"("id", "workspace_id") ON DELETE CASCADE,
  CONSTRAINT "legal_list_claim_carry_outcomes_source_claim_fk" FOREIGN KEY ("source_claim_id", "source_run_id", "workspace_id") REFERENCES "legal_list_claims"("id", "run_id", "workspace_id") ON DELETE CASCADE,
  CONSTRAINT "legal_list_claim_carry_outcomes_target_claim_fk" FOREIGN KEY ("target_claim_id", "run_id", "workspace_id") REFERENCES "legal_list_claims"("id", "run_id", "workspace_id") ON DELETE CASCADE,
  CONSTRAINT "legal_list_claim_carry_outcomes_outcome_check" CHECK ("outcome" IN ('carried', 'text-changed', 'verdict-changed', 'unmatched', 'ambiguous')),
  CONSTRAINT "legal_list_claim_carry_outcomes_target_check" CHECK (("target_claim_id" IS NOT NULL) = ("outcome" IN ('carried', 'text-changed', 'verdict-changed')))
);--> statement-breakpoint
-- Built with the empty table, so nothing is scanned.
CREATE INDEX "legal_list_claim_carry_outcomes_run_idx" ON "legal_list_claim_carry_outcomes" ("workspace_id", "run_id");--> statement-breakpoint
CREATE INDEX "legal_list_claim_carry_outcomes_source_claim_idx" ON "legal_list_claim_carry_outcomes" ("workspace_id", "source_claim_id");--> statement-breakpoint
CREATE INDEX "legal_list_claim_carry_outcomes_target_claim_idx" ON "legal_list_claim_carry_outcomes" ("workspace_id", "target_claim_id");--> statement-breakpoint

ALTER TABLE "legal_list_claim_carry_outcomes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_list_claim_carry_outcomes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "legal_list_claim_carry_outcomes" TO stella;--> statement-breakpoint

CREATE POLICY "workspace_select" ON "legal_list_claim_carry_outcomes"
  AS PERMISSIVE FOR SELECT TO stella USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
    ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
  END));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "legal_list_claim_carry_outcomes"
  AS PERMISSIVE FOR INSERT TO stella WITH CHECK ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
    ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
  END));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "legal_list_claim_carry_outcomes"
  AS PERMISSIVE FOR UPDATE TO stella USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
    ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
  END));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "legal_list_claim_carry_outcomes"
  AS PERMISSIVE FOR DELETE TO stella USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
    ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
  END));
