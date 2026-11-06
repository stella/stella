SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- The online phase builds case_law_decisions_ecli_upper_idx CONCURRENTLY after
-- this transaction commits, so an ECLI lookup compares the column folded.
SELECT 1;
