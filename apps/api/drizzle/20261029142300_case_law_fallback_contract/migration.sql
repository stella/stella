-- requires: 20261029142200_case_law_fallback_identity
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
-- Record the contract release. The online runner validates the court/evidence
-- and content replacements before retiring the obsolete docket-only index
-- using DROP INDEX CONCURRENTLY.
SELECT 1;
