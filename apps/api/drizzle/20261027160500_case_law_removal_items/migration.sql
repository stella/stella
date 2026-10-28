-- requires: 20261027160300_case_law_removal_retry_lane
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "case_law_removal_reconciliation_items" (
  "id" uuid PRIMARY KEY,
  "source_id" uuid NOT NULL CONSTRAINT "case_law_removal_items_source_fk" REFERENCES "case_law_sources"("id") ON DELETE CASCADE,
  "decision_id" uuid NOT NULL CONSTRAINT "case_law_removal_items_decision_fk" REFERENCES "case_law_decisions"("id") ON DELETE CASCADE,
  "kind" varchar(32) NOT NULL,
  "payload" jsonb NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL,
  "last_error" text NOT NULL,
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "last_attempt_at" timestamptz NOT NULL,
  CONSTRAINT "case_law_removal_items_kind_values" CHECK ("kind" IN ('removal-erasure', 'removal-pending', 'removal-unprobeable')),
  CONSTRAINT "case_law_removal_items_attempts_nonnegative" CHECK ("attempts" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "case_law_removal_items_source_decision_idx" ON "case_law_removal_reconciliation_items" ("source_id", "decision_id");--> statement-breakpoint
CREATE INDEX "case_law_removal_items_due_idx" ON "case_law_removal_reconciliation_items" ("source_id", "kind", "next_attempt_at", "id");--> statement-breakpoint
ALTER TABLE "case_law_removal_reconciliation_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_removal_reconciliation_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_global_access" ON "case_law_removal_reconciliation_items" FOR SELECT TO stella USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_removal_reconciliation_items" FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT ON TABLE "case_law_removal_reconciliation_items" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "case_law_removal_reconciliation_items" TO stella_ingestion;
