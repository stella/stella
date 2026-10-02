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
  CONSTRAINT "case_law_replay_batches_source_id_case_law_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."case_law_sources"("id") ON DELETE RESTRICT,
  CONSTRAINT "case_law_replay_batches_status_check" CHECK ("status" IN ('reserved', 'completed', 'superseded')),
  CONSTRAINT "case_law_replay_batches_counts_check" CHECK ("attempted" > 0 AND "applied" >= 0 AND "blocked" >= 0 AND "failed" >= 0 AND "applied" + "blocked" + "failed" <= "attempted" AND "duration_ms" >= 0)
);--> statement-breakpoint
CREATE INDEX "case_law_replay_batches_source_budget_idx" ON "case_law_replay_batches" ("source_id", "budget_day");--> statement-breakpoint
CREATE INDEX "case_law_replay_batches_source_status_idx" ON "case_law_replay_batches" ("source_id", "status");--> statement-breakpoint
CREATE TABLE "case_law_replay_blocked" (
  "source_id" uuid NOT NULL,
  "decision_id" uuid NOT NULL,
  "parser_version_from" integer,
  "parser_version_to" integer NOT NULL,
  "reason" text NOT NULL,
  "detail" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_replay_blocked_decision_id_parser_version_to_pk" PRIMARY KEY ("decision_id", "parser_version_to"),
  CONSTRAINT "case_law_replay_blocked_source_id_case_law_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."case_law_sources"("id") ON DELETE RESTRICT,
  CONSTRAINT "case_law_replay_blocked_reason_check" CHECK ("reason" IN ('incomplete-metadata', 'identity-mismatch', 'raw-fidelity-lost', 'unsupported-content', 'no-document', 'supplement', 'missing-payload'))
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
