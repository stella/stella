-- requires: 20261005120100_validate_desktop_handoff_failure
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "case_law_sources"
  ADD COLUMN "ingestion_lease_purpose" text NOT NULL DEFAULT 'ingestion';--> statement-breakpoint

ALTER TABLE "case_law_sources"
  ADD CONSTRAINT "case_law_sources_ingestion_lease_purpose_valid"
  CHECK ("ingestion_lease_purpose" IN ('ingestion', 'decision-merge')) NOT VALID;--> statement-breakpoint

ALTER TABLE "case_law_sources"
  ADD COLUMN "decision_merge_epoch" bigint NOT NULL DEFAULT 0;--> statement-breakpoint

GRANT UPDATE (ingestion_lease_purpose, decision_merge_epoch)
  ON TABLE "case_law_sources" TO stella_ingestion;
