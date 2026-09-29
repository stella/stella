SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "case_law_search_backfill_failures" (
  "decision_id" uuid PRIMARY KEY NOT NULL,
  "source_updated_at" timestamptz NOT NULL,
  "attempt_count" integer NOT NULL,
  "last_error_class" varchar(80) NOT NULL,
  "status" varchar(16) NOT NULL,
  "next_eligible_at" timestamptz,
  "last_failed_at" timestamptz NOT NULL,
  CONSTRAINT "case_law_search_backfill_failures_attempt_positive"
    CHECK ("attempt_count" >= 1),
  CONSTRAINT "case_law_search_backfill_failures_status_values"
    CHECK ("status" IN ('cooldown', 'parked')),
  CONSTRAINT "case_law_search_backfill_failures_schedule_shape"
    CHECK (("status" = 'cooldown' AND "next_eligible_at" IS NOT NULL)
      OR ("status" = 'parked' AND "next_eligible_at" IS NULL))
);--> statement-breakpoint

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "case_law_search_backfill_failures"
  ADD CONSTRAINT "case_law_search_backfill_failure_decision_fk"
  FOREIGN KEY ("decision_id") REFERENCES "public"."case_law_decisions"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "case_law_search_backfill_failures_status_idx"
  ON "case_law_search_backfill_failures" ("status");--> statement-breakpoint

ALTER TABLE "case_law_search_backfill_failures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_search_backfill_failures" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "case_law_global_access" ON "case_law_search_backfill_failures"
  AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_search_backfill_failures"
  AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint

GRANT SELECT ON TABLE "case_law_search_backfill_failures" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "case_law_search_backfill_failures" TO stella_ingestion;
