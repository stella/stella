-- requires: 20261007090000_case_law_citation_review_provenance
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "case_law_citation_reviews"
  VALIDATE CONSTRAINT "citation_reviews_origin_values";--> statement-breakpoint
ALTER TABLE "case_law_citation_reviews"
  VALIDATE CONSTRAINT "citation_reviews_origin_provenance";
