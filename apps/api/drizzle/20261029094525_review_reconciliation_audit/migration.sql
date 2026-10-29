SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
CREATE POLICY "system_audit_runs_ingestion_review_insert" ON "system_audit_runs"
FOR INSERT TO stella_ingestion
WITH CHECK (actor = 'system:case-law-review-reconcile');--> statement-breakpoint
GRANT INSERT ON TABLE "system_audit_runs" TO stella_ingestion;
