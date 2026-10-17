-- requires: 20261016100700_case_law_review_text_revision
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5min';--> statement-breakpoint

-- Validate after the additive migration commits. The scan tracks the review
-- registry volume and holds only SHARE UPDATE EXCLUSIVE; a timeout fails
-- this migration, and rerunning retries the validation.
ALTER TABLE "case_law_citation_reviews"
  VALIDATE CONSTRAINT "citation_reviews_text_revision_sha256";

--> statement-breakpoint
ALTER TABLE "case_law_citation_doctrine_reviews"
  VALIDATE CONSTRAINT "citation_doctrine_reviews_text_revision_sha256";
