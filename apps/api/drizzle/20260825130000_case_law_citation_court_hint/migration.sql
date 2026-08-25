SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The court phrase the citing sentence named, kept so the resolver can tell
-- apart a docket number that several regional courts reuse. Nullable and
-- additive; rows extracted before this column carry no hint until their
-- decision is re-extracted.
ALTER TABLE "case_law_citations"
  ADD COLUMN "cited_court_hint" varchar(128);
