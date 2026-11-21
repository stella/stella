-- requires: 20261019090100_soft_law_legacy_receipt_entry_type
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

ALTER TABLE "case_law_decisions"
  ADD COLUMN "source_hash_version" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint

CREATE OR REPLACE VIEW "case_law_published_decisions" AS
SELECT *
FROM "case_law_decisions"
WHERE (redacted_at IS NULL AND jsonb_extract_path_text(metadata, '_stellaPartialObservation', 'isListingOnly') is distinct from 'true');--> statement-breakpoint

CREATE OR REPLACE VIEW "case_law_unredacted_decisions" AS
SELECT *
FROM "case_law_decisions"
WHERE redacted_at IS NULL;
