-- requires: 20260926160000_case_law_provision_extraction_state
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Record the schema intent; the high-volume table's concurrent build and
-- interrupted-build repair run in the guarded online migration phase.
-- See src/db/online-migrations.ts.
SELECT 1;
