SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

ALTER TABLE "document_review_findings"
  ADD COLUMN "application_status" text DEFAULT 'pending' NOT NULL,
  ADD COLUMN "applied_by" text,
  ADD COLUMN "applied_at" timestamptz;--> statement-breakpoint

ALTER TABLE "document_review_findings"
  ADD CONSTRAINT "document_review_findings_application_status_values_check"
  CHECK ("application_status" IN ('pending', 'applied')) NOT VALID;--> statement-breakpoint

ALTER TABLE "document_review_findings"
  ADD CONSTRAINT "document_review_findings_application_timing_check"
  CHECK (("application_status" = 'pending') = ("applied_at" IS NULL)) NOT VALID;--> statement-breakpoint

ALTER TABLE "document_review_findings"
  ADD CONSTRAINT "document_review_findings_applied_by_user_id_fk"
  FOREIGN KEY ("applied_by") REFERENCES "public"."user" ("id")
  ON DELETE SET NULL NOT VALID;
