-- requires: 20261029141500_case_law_coverage_snapshot_freshness
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Every release since the expand step reads stella_case_law_coverage_summary_v2().
-- stella-migration-safety: reviewed drop-object - the original summary reader has no caller once releases before the versioned reader are retired; it returns only the stored summary
DROP FUNCTION public.stella_case_law_coverage_summary();
