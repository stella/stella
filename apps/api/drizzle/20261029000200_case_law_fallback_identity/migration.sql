SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "case_law_decisions" ADD COLUMN "fallback_identity_key" varchar(320),
  ADD COLUMN "fallback_cohort_key" varchar(320),
  ADD COLUMN "fallback_content_hash" varchar(64),
  ADD COLUMN "fallback_publication_hash" varchar(64);
-- The source-scoped unique index is built by the governed online runner.
-- Existing rows are not rewritten; an observed exact identity fills its key.
--> statement-breakpoint
CREATE OR REPLACE VIEW "case_law_published_decisions" AS
SELECT * FROM "case_law_decisions"
WHERE (redacted_at IS NULL AND jsonb_extract_path_text(metadata, '_stellaPartialObservation', 'isListingOnly') is distinct from 'true');
--> statement-breakpoint
CREATE OR REPLACE VIEW "case_law_unredacted_decisions" AS
SELECT * FROM "case_law_decisions" WHERE redacted_at IS NULL;
