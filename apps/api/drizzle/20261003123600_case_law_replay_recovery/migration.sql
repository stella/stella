-- requires: 20261003123500_case_law_replay_receipts
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "case_law_replay_batches"
  ADD COLUMN "superseded_at" timestamptz,
  ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "attempt_state" text DEFAULT 'idle' NOT NULL,
  ADD COLUMN "retry_at" timestamptz,
  ADD COLUMN "failure_code" text,
  ADD COLUMN "failure_message_class" text;--> statement-breakpoint
ALTER TABLE "case_law_replay_batches" ADD CONSTRAINT "case_law_replay_batches_attempt_state_check" CHECK ("attempt_state" IN ('idle', 'picked-up'));--> statement-breakpoint
ALTER TABLE "case_law_replay_batches" DROP CONSTRAINT "case_law_replay_batches_status_check";--> statement-breakpoint
ALTER TABLE "case_law_replay_batches" ADD CONSTRAINT "case_law_replay_batches_status_check" CHECK ("status" IN ('reserved', 'completed', 'superseded', 'failed', 'blocked'));--> statement-breakpoint
ALTER TABLE "case_law_replay_batches" ADD CONSTRAINT "case_law_replay_batches_failure_code_check" CHECK ("failure_code" IS NULL OR "failure_code" IN ('stored-raw-timeout', 'stored-raw-too-large', 'stored-raw-read', 'adapter-exception', 'writer-retryable', 'receipt-write', 'tick-deadline', 'tick-cancelled', 'unexpected'));--> statement-breakpoint
ALTER TABLE "case_law_replay_batches" DROP CONSTRAINT "case_law_replay_batches_counts_check";--> statement-breakpoint
ALTER TABLE "case_law_replay_batches" ADD CONSTRAINT "case_law_replay_batches_counts_check" CHECK ("attempts" >= 0 AND "attempted" > 0 AND "applied" >= 0 AND "blocked" >= 0 AND "failed" >= 0 AND "applied" + "blocked" + "failed" <= "attempted" AND "duration_ms" >= 0);--> statement-breakpoint
ALTER TABLE "case_law_replay_blocked" DROP CONSTRAINT "case_law_replay_blocked_reason_check";--> statement-breakpoint
ALTER TABLE "case_law_replay_blocked" ADD CONSTRAINT "case_law_replay_blocked_reason_check" CHECK ("reason" IN ('missing-payload', 'no-write-settled', 'redacted', 'superseded', 'retry-exhausted', 'incomplete-metadata', 'identity-mismatch', 'raw-fidelity-lost', 'unsupported-content', 'no-document', 'supplement'));--> statement-breakpoint
CREATE INDEX "case_law_replay_batches_due_idx" ON "case_law_replay_batches" ("source_id", "status", "retry_at");--> statement-breakpoint
CREATE INDEX "case_law_replay_batches_document_version_idx" ON "case_law_replay_batches" ("source_id", "first_decision_id", "parser_version_to");--> statement-breakpoint
CREATE INDEX "case_law_replay_batches_retention_idx" ON "case_law_replay_batches" ("superseded_at", "id") WHERE "superseded_at" IS NOT NULL;--> statement-breakpoint
-- Large corpus indexes are built concurrently by the migrator's sanctioned
-- ONLINE_MIGRATION_INDEXES phase after transactional schema migrations.
CREATE TABLE "case_law_replay_source_progress" (
  "source_id" uuid NOT NULL,
  CONSTRAINT "case_law_replay_source_progress_pkey" PRIMARY KEY ("source_id"),
  CONSTRAINT "case_law_replay_progress_source_fk" FOREIGN KEY ("source_id") REFERENCES "public"."case_law_sources"("id") ON DELETE RESTRICT,
  "ticks_without_progress" integer DEFAULT 0 NOT NULL,
  "last_completed_at" timestamptz,
  CONSTRAINT "case_law_replay_source_progress_ticks_check" CHECK ("ticks_without_progress" >= 0)
);--> statement-breakpoint
ALTER TABLE "case_law_replay_source_progress" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_replay_source_progress" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_replay_source_progress_owner_access" ON "case_law_replay_source_progress"
  AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_source_progress'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_source_progress'::regclass));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_replay_source_progress" FROM stella;--> statement-breakpoint
CREATE TABLE "case_law_replay_audit_events" (
  "id" text NOT NULL,
  CONSTRAINT "case_law_replay_audit_events_pkey" PRIMARY KEY ("id"),
  "source_id" uuid,
  CONSTRAINT "case_law_replay_audit_source_fk" FOREIGN KEY ("source_id") REFERENCES "public"."case_law_sources"("id") ON DELETE RESTRICT,
  "service_id" text NOT NULL,
  "action" text NOT NULL,
  "resource_id" text NOT NULL,
  "details" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_replay_audit_events_action_check" CHECK ("action" IN ('source-scheduled', 'daily-row-charged', 'receipt-superseded', 'checkpoint-created', 'gate-state-saved', 'receipt-reserved', 'progress-completed', 'receipt-applied', 'receipt-failed', 'receipt-blocked', 'dry-run-advanced', 'dry-run-reset', 'receipts-compacted', 'tick-recorded')),
  CONSTRAINT "case_law_replay_audit_events_service_check" CHECK ("service_id" = 'case-law-background-replay'),
  CONSTRAINT "case_law_replay_audit_events_details_check" CHECK (jsonb_typeof("details") = 'object' AND octet_length("details"::text) <= 32768)
);--> statement-breakpoint
CREATE INDEX "case_law_replay_audit_events_retention_idx" ON "case_law_replay_audit_events" ("created_at", "id");--> statement-breakpoint
CREATE INDEX "case_law_replay_audit_events_source_idx" ON "case_law_replay_audit_events" ("source_id", "created_at", "id");--> statement-breakpoint
ALTER TABLE "case_law_replay_audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_replay_audit_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_replay_audit_events_owner_access" ON "case_law_replay_audit_events"
  AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_audit_events'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_audit_events'::regclass));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_replay_audit_events" FROM stella;--> statement-breakpoint
