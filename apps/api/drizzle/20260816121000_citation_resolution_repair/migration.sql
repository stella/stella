SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30min';--> statement-breakpoint

-- The scans 20260816120000 deferred: three constraint validations and the two
-- repairs one of them needs first. Bounded, but generously: every statement
-- here reads one of the two largest tables in the corpus end to end, and none
-- of them takes a lock that blocks a reader or a writer.

-- Repair the sentinel drift before validating it away. One writer stored ''
-- for a text that does not canonicalize where the other stored NULL, so a
-- database that ran the older backfill holds rows the new constraint would
-- reject. NULL is the surviving spelling; '' rows would otherwise have joined
-- each other.
-- stella-migration-safety: reviewed bulk-backfill - rewrites a sentinel that
-- never named a key to the NULL that means the same thing; idempotent, and
-- production holds no such row.
UPDATE "case_law_citations" SET "citation_key" = NULL WHERE "citation_key" = '';--> statement-breakpoint
UPDATE "case_law_decisions" SET "citation_key" = NULL WHERE "citation_key" = '';--> statement-breakpoint

-- Carry the outcome the old representation did record. A row already linked
-- to a decision was resolved by the previous algorithm; everything else stays
-- pending and is examined once by the new one. Idempotent, so a re-run after
-- an interrupted migration repeats no work.
-- stella-migration-safety: reviewed bulk-backfill - restates the outcome
-- already implied by cited_decision_id; served by the partial cited index and
-- touches no row whose status is already set.
UPDATE "case_law_citations"
   SET "resolution_status" = 'resolved'
 WHERE "cited_decision_id" IS NOT NULL
   AND "resolution_status" = 'pending';--> statement-breakpoint

-- VALIDATE takes SHARE UPDATE EXCLUSIVE rather than the ACCESS EXCLUSIVE the
-- ADD would have needed, so concurrent readers and writers keep running for
-- the length of the scan. Same shape as 20260813100100.
ALTER TABLE "case_law_citations" VALIDATE CONSTRAINT "citations_resolution_status_values";--> statement-breakpoint
ALTER TABLE "case_law_citations" VALIDATE CONSTRAINT "citations_citation_key_non_empty";--> statement-breakpoint
ALTER TABLE "case_law_decisions" VALIDATE CONSTRAINT "decisions_citation_key_non_empty";
