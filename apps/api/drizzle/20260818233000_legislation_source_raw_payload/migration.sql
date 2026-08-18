SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Where a legislation Expression's verbatim publisher response is kept, so a
-- parser improvement can be replayed without re-crawling the source. The twin
-- of case_law_decisions.source_raw_s3_key / source_raw_content_type; the
-- payload itself lives in object storage under a content-addressed key.
--
-- Both nullable with no default and no backfill: every existing row predates
-- any legislation adapter, so there is nothing to fill in. Adding a nullable
-- column without a default takes ACCESS EXCLUSIVE only long enough to update
-- the catalog.
ALTER TABLE "legislation_documents"
  ADD COLUMN IF NOT EXISTS "source_raw_s3_key" varchar(512);--> statement-breakpoint
ALTER TABLE "legislation_documents"
  ADD COLUMN IF NOT EXISTS "source_raw_content_type" varchar(128);
