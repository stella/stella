SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The printed number of the paragraph a claim sits in, read once when its
-- run stores the claims. A nullable column with no default, so no row is
-- rewritten: claims stored before stay null, as the run read shows a claim
-- outside any numbered paragraph. Nothing reads it until this release.
ALTER TABLE "legal_list_claims" ADD COLUMN "paragraph_number" integer;
