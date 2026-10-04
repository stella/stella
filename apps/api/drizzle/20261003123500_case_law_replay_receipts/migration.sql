SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "case_law_replay_batches" (
  "id" text PRIMARY KEY NOT NULL,
  "source_id" uuid NOT NULL,
  "first_decision_id" uuid NOT NULL,
  "last_decision_id" uuid NOT NULL,
  "parser_version_from" integer,
  "parser_version_to" integer NOT NULL,
  "budget_day" date NOT NULL,
  "status" text NOT NULL,
  "outcome" text,
  "attempted" integer NOT NULL,
  "applied" integer DEFAULT 0 NOT NULL,
  "blocked" integer DEFAULT 0 NOT NULL,
  "failed" integer DEFAULT 0 NOT NULL,
  "duration_ms" integer DEFAULT 0 NOT NULL,
  "gate_verdict" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz,
  "superseded_at" timestamptz,
  "attempts" integer DEFAULT 0 NOT NULL,
  "readmissions" integer DEFAULT 0 NOT NULL,
  "systemic_failures" integer DEFAULT 0 NOT NULL,
  "systemic_progress" bigint DEFAULT 0 NOT NULL,
  "attempt_state" text DEFAULT 'idle' NOT NULL,
  "retry_at" timestamptz,
  "failure_code" text,
  "failure_message_class" text,
  CONSTRAINT "case_law_replay_batches_source_id_case_law_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."case_law_sources"("id") ON DELETE RESTRICT,
  CONSTRAINT "case_law_replay_batches_attempt_state_check" CHECK ("attempt_state" IN ('idle', 'picked-up')),
  CONSTRAINT "case_law_replay_batches_failure_code_check" CHECK ("failure_code" IS NULL OR "failure_code" IN ('stored-raw-timeout', 'stored-raw-too-large', 'stored-raw-read', 'adapter-exception', 'writer-retryable', 'receipt-write', 'tick-deadline', 'tick-cancelled', 'unexpected')),
  CONSTRAINT "case_law_replay_batches_status_check" CHECK ("status" IN ('reserved', 'retry-exhausted', 'retry-terminal', 'completed', 'superseded', 'failed', 'blocked')),
  CONSTRAINT "case_law_replay_batches_readmission_check" CHECK (("status" NOT IN ('retry-exhausted', 'retry-terminal')) OR ("failure_code" IS NOT NULL AND "attempt_state" = 'idle' AND (("status" = 'retry-exhausted' AND "retry_at" IS NOT NULL AND "readmissions" < 3) OR ("status" = 'retry-terminal' AND "retry_at" IS NULL AND "readmissions" = 3)))),
  CONSTRAINT "case_law_replay_batches_counts_check" CHECK ("readmissions" >= 0 AND "readmissions" <= 3 AND "systemic_failures" >= 0 AND "systemic_progress" >= 0 AND "attempts" >= 0 AND "attempted" > 0 AND "applied" >= 0 AND "blocked" >= 0 AND "failed" >= 0 AND "applied" + "blocked" + "failed" <= "attempted" AND "duration_ms" >= 0)
);--> statement-breakpoint
CREATE INDEX "case_law_replay_batches_source_budget_idx" ON "case_law_replay_batches" ("source_id", "budget_day");--> statement-breakpoint
CREATE INDEX "case_law_replay_batches_source_status_idx" ON "case_law_replay_batches" ("source_id", "status");--> statement-breakpoint
CREATE INDEX "case_law_replay_batches_due_idx" ON "case_law_replay_batches" ("source_id", "status", "retry_at");--> statement-breakpoint
CREATE INDEX "case_law_replay_batches_document_version_idx" ON "case_law_replay_batches" ("source_id", "first_decision_id", "parser_version_to");--> statement-breakpoint
CREATE INDEX "case_law_replay_batches_retention_idx" ON "case_law_replay_batches" ("superseded_at", "id") WHERE "superseded_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "case_law_replay_batches_retire_idx" ON "case_law_replay_batches" ("source_id", "parser_version_to", "id") WHERE "superseded_at" IS NULL AND "status" IN ('completed', 'superseded', 'failed', 'retry-exhausted', 'retry-terminal', 'blocked');--> statement-breakpoint
CREATE TABLE "case_law_replay_blocked" (
  "source_id" uuid NOT NULL,
  "decision_id" uuid NOT NULL,
  "parser_version_from" integer,
  "parser_version_to" integer NOT NULL,
  "outcome" text NOT NULL,
  "reason" text,
  "detail" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_replay_blocked_decision_id_parser_version_to_pk" PRIMARY KEY ("decision_id", "parser_version_to"),
  CONSTRAINT "case_law_replay_blocked_source_id_case_law_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."case_law_sources"("id") ON DELETE RESTRICT,
  CONSTRAINT "case_law_replay_blocked_outcome_check" CHECK ("outcome" IN ('changed', 'unchanged', 'rejected') AND (("outcome" = 'rejected' AND "reason" IS NOT NULL) OR ("outcome" <> 'rejected' AND "reason" IS NULL))),
  CONSTRAINT "case_law_replay_blocked_reason_check" CHECK ("reason" IN ('missing-payload', 'incomplete-metadata', 'identity-mismatch', 'raw-fidelity-lost', 'unsupported-content', 'no-document', 'supplement'))
);--> statement-breakpoint
CREATE INDEX "case_law_replay_blocked_source_version_idx" ON "case_law_replay_blocked" ("source_id", "parser_version_to", "decision_id");--> statement-breakpoint
ALTER TABLE "case_law_replay_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_replay_batches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_replay_batches_owner_access" ON "case_law_replay_batches"
  AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_batches'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_batches'::regclass));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_replay_batches" FROM stella;--> statement-breakpoint
ALTER TABLE "case_law_replay_blocked" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_replay_blocked" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_replay_blocked_owner_access" ON "case_law_replay_blocked"
  AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_blocked'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_blocked'::regclass));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_replay_blocked" FROM stella;--> statement-breakpoint

CREATE TABLE "case_law_replay_daily_rows" (
  "batch_id" text NOT NULL,
  "budget_day" date NOT NULL,
  "source_id" uuid NOT NULL,
  CONSTRAINT "case_law_replay_daily_rows_batch_id_budget_day_pk" PRIMARY KEY ("batch_id", "budget_day"),
  CONSTRAINT "case_law_replay_daily_batch_fk" FOREIGN KEY ("batch_id") REFERENCES "case_law_replay_batches"("id") ON DELETE RESTRICT,
  CONSTRAINT "case_law_replay_daily_rows_source_id_case_law_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."case_law_sources"("id") ON DELETE RESTRICT
);--> statement-breakpoint
CREATE INDEX "case_law_replay_daily_rows_source_day_idx" ON "case_law_replay_daily_rows" ("source_id", "budget_day");--> statement-breakpoint
ALTER TABLE "case_law_replay_daily_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_replay_daily_rows" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_replay_daily_rows_owner_access" ON "case_law_replay_daily_rows"
  AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_daily_rows'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_daily_rows'::regclass));--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_replay_daily_rows" FROM stella;--> statement-breakpoint

CREATE TABLE "case_law_replay_source_progress" (
  "source_id" uuid NOT NULL,
  CONSTRAINT "case_law_replay_source_progress_pkey" PRIMARY KEY ("source_id"),
  CONSTRAINT "case_law_replay_progress_source_fk" FOREIGN KEY ("source_id") REFERENCES "public"."case_law_sources"("id") ON DELETE RESTRICT,
  "ticks_without_progress" integer DEFAULT 0 NOT NULL,
  "last_completed_at" timestamptz,
  "completed_rows" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "case_law_replay_source_progress_ticks_check" CHECK ("ticks_without_progress" >= 0 AND "completed_rows" >= 0)
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
