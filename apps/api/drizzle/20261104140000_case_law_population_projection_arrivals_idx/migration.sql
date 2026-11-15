SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- The online phase builds case_law_population_projection_arrivals_idx
-- CONCURRENTLY after this transaction commits: a court's arrivals as a
-- created_at range, which the per-court breakdown reads.
SELECT 1;
