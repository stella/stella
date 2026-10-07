-- requires: 20261005120600_verification_document_cascade
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
ALTER TABLE "legal_list_verification_runs"
  VALIDATE CONSTRAINT "legal_list_verification_runs_entity_fk";
