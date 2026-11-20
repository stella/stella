SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The case-number match-key indexes (case_law_decision_identifiers_match_key_idx,
-- case_law_decisions_citation_match_key_idx,
-- case_law_decisions_citation_match_key_published_idx,
-- case_law_citations_reopenable_match_key_idx,
-- case_law_citations_reopenable_identifier_match_key_idx and
-- case_law_citations_identifier_backfill_match_key_idx) are built concurrently
-- after deploy by their online migration entries in
-- apps/api/src/db/online-migration-entries/.
