SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The pending-polarity index (case_law_citations_polarity_pending_idx) is
-- built concurrently after deploy by its online migration entry in
-- apps/api/src/db/online-migration-entries/, which then retires
-- case_law_citations_polarity_null_idx once the replacement is valid.
