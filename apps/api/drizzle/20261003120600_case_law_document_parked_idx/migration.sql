SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The deferred-document queue's parked rows, read by the count and the
-- requeue without walking the pending backlog. The threshold is
-- MAX_DOCUMENT_FETCH_ATTEMPTS, spelled as a literal so the queue's inlined
-- predicate can be proven to imply it.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_document_parked_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_document_parked_idx"
  ON "case_law_decisions" ("source_id", "id")
  WHERE "fulltext" is null AND "document_url" is not null
    AND "document_fetch_attempts" >= 8;
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
