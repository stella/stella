SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The full decisions match-key index (case_law_decisions_citation_match_key_all_idx)
-- is built concurrently after deploy by its online migration entry in
-- apps/api/src/db/online-migration-entries/, which then retires the partial
-- case_law_decisions_citation_match_key_idx once the replacement is valid.
