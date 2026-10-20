-- requires: 20261019090100_soft_law_legacy_receipt_entry_type
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

ALTER TABLE "case_law_decisions"
  ADD COLUMN "source_hash_version" smallint DEFAULT 0 NOT NULL;
