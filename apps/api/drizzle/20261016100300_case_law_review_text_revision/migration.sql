-- requires: 20261016100200_case_law_citation_polarity_evidence_validate
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Older writers may omit the revision during rollout. Such model reviews
-- remain stored but cannot classify the current decision text.
ALTER TABLE "case_law_citation_reviews"
  ADD COLUMN "text_revision_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "case_law_citation_reviews"
  ADD CONSTRAINT "citation_reviews_text_revision_sha256"
  CHECK ("text_revision_sha256" IS NULL OR "text_revision_sha256" ~ '^[0-9a-f]{64}$') NOT VALID;

--> statement-breakpoint
ALTER TABLE "case_law_citation_doctrine_reviews"
  ADD COLUMN "text_revision_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "case_law_citation_doctrine_reviews"
  ADD CONSTRAINT "citation_doctrine_reviews_text_revision_sha256"
  CHECK ("text_revision_sha256" IS NULL OR "text_revision_sha256" ~ '^[0-9a-f]{64}$') NOT VALID;
