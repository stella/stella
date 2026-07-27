-- Deferred-document fetch bookkeeping for case-law decisions.
--
-- Additive only: two nullable/defaulted columns plus two partial
-- indexes. Existing rows read as "never requested, never attempted",
-- which is the correct starting state for both the read-through path
-- and the queue.

-- Bound lock waits; the index builds below run against a large table.
set lock_timeout = '10s';
--> statement-breakpoint
set statement_timeout = '10min';
--> statement-breakpoint

ALTER TABLE "case_law_decisions"
  ADD COLUMN "document_fetch_requested_at" timestamp;
--> statement-breakpoint
-- Defaulted NOT NULL: PostgreSQL 11+ stores the default in the catalog,
-- so this does not rewrite the table.
ALTER TABLE "case_law_decisions"
  ADD COLUMN "document_fetch_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- Priority tier: decisions a reader has asked for that still have no
-- document. Partial on the pending predicate, so the index covers the
-- queue rather than the corpus.
-- The only writers to case_law_decisions are the ingestion daemon and
-- the read-through path, both of which retry; blocking their writes for
-- the build is acceptable and reads stay available, so CONCURRENTLY
-- (which would require splitting the wrapping transaction) is not used.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "case_law_decisions_document_demand_idx"
  ON "case_law_decisions" ("document_fetch_requested_at", "id")
  WHERE "fulltext" is null
    AND "document_url" is not null
    AND "document_fetch_requested_at" is not null;
--> statement-breakpoint
-- Remaining tier: newest decisions first, per source. Matches the
-- loader's ORDER BY so the head of the queue is a bounded index range
-- scan.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "case_law_decisions_document_pending_idx"
  ON "case_law_decisions" ("source_id", "decision_date" DESC NULLS LAST, "id")
  WHERE "fulltext" is null AND "document_url" is not null;
