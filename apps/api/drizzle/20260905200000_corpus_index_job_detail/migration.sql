SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- Why a succeeded index-job row was written, kept apart from the failure it
-- is not. `error_message` is read as the failure of the row it sits on, so a
-- withdrawal filing its reason there reads as an operation that failed. The
-- reason moves to `detail`, and `error_message` keeps its one meaning.
--
-- Nullable with no default: existing rows are untouched and the table takes
-- only a catalog change. Same width as `error_message` in both tables, so a
-- reason is bounded the same way whichever column a reader came for.
-- Rollback drops the column; nothing reads it before this deploys.
ALTER TABLE "case_law_index_jobs"
  ADD COLUMN IF NOT EXISTS "detail" varchar(2048);--> statement-breakpoint

-- The trail is one shape across both families, so both tables move together.
ALTER TABLE "legislation_index_jobs"
  ADD COLUMN IF NOT EXISTS "detail" varchar(2048);--> statement-breakpoint

-- Withdrawals recorded before this migration hold their reason in the failure
-- column, so the rows written under the old writer are moved to the new one:
-- without this the trail would mean two different things depending on when a
-- row was written, and the constraint below could not stand.
--
-- Bounded by construction: only `withdraw` rows that carry a message are
-- rewritten, an operation recorded by an operator action rather than by the
-- indexing loop. The predicate has no index of its own, so the cost is one
-- pass over each table, which is what the wider statement budget above is
-- for. Idempotent: a second run matches nothing, because the column it reads
-- is cleared by the same statement. Rollback is the mirrored update.
UPDATE "case_law_index_jobs"
  SET "detail" = "error_message", "error_message" = NULL
  WHERE "operation" = 'withdraw'
    AND "status" = 'succeeded'
    AND "error_message" IS NOT NULL;--> statement-breakpoint

UPDATE "legislation_index_jobs"
  SET "detail" = "error_message", "error_message" = NULL
  WHERE "operation" = 'withdraw'
    AND "status" = 'succeeded'
    AND "error_message" IS NOT NULL;--> statement-breakpoint

-- The split the column exists for, enforced by the database rather than by
-- every writer remembering it: a row that succeeded carries no failure. The
-- reverse is deliberately not constrained — a failed row may record both what
-- it was for and what went wrong.
--
-- NOT VALID: the statement above moved every row this could reject, so there
-- is nothing to scan; the constraint still applies to every later INSERT and
-- UPDATE, which is where the invariant has to hold. Rollback drops it.
--
-- This is the one place the change is not additive across a rollout: a writer
-- from before it that still files a withdrawal's reason in `error_message` has
-- its insert rejected. That path fails closed rather than writing a row the
-- trail would misread — the audit row and the columns it describes share one
-- transaction, so nothing half-written survives, and the withdrawal can be
-- made again once the writer is replaced.
ALTER TABLE "case_law_index_jobs"
  ADD CONSTRAINT "case_law_index_jobs_succeeded_error_message"
  CHECK ("status" <> 'succeeded' OR "error_message" IS NULL) NOT VALID;--> statement-breakpoint

ALTER TABLE "legislation_index_jobs"
  ADD CONSTRAINT "legislation_index_jobs_succeeded_error_message"
  CHECK ("status" <> 'succeeded' OR "error_message" IS NULL) NOT VALID;
