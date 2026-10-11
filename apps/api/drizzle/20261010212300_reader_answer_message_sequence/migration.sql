-- requires: 20261010212200_reader_answer_message_diagnostics
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "legal_reader_answer_messages" ADD COLUMN IF NOT EXISTS "sequence" integer;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Recreates the same sequence checks in this transaction for replay; NOT NULL metadata remains enforced after a completed promotion.
ALTER TABLE "legal_reader_answer_messages"
  DROP CONSTRAINT IF EXISTS "legal_reader_answer_messages_sequence_positive",
  DROP CONSTRAINT IF EXISTS "legal_reader_answer_messages_sequence_not_null";--> statement-breakpoint
ALTER TABLE "legal_reader_answer_messages"
  ADD CONSTRAINT "legal_reader_answer_messages_sequence_positive" CHECK ("sequence" > 0) NOT VALID,
  ADD CONSTRAINT "legal_reader_answer_messages_sequence_not_null" CHECK ("sequence" IS NOT NULL) NOT VALID;--> statement-breakpoint

-- Release schema locks before the backfill and constraint scans.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint

-- Preserve the previous canonical order for existing feature rows before the new writer starts.
WITH ordered AS (
  SELECT "id", row_number() OVER (PARTITION BY "answer_id" ORDER BY "created_at", "id") AS "sequence"
  FROM "legal_reader_answer_messages"
)
UPDATE "legal_reader_answer_messages" AS message
SET "sequence" = ordered."sequence"::integer
FROM ordered
WHERE message."id" = ordered."id" AND message."sequence" IS NULL;--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- Added NOT VALID in the committed transaction above; validation holds no earlier schema lock.
ALTER TABLE "legal_reader_answer_messages"
  VALIDATE CONSTRAINT "legal_reader_answer_messages_sequence_positive";--> statement-breakpoint
-- squawk-ignore constraint-missing-not-valid -- Added NOT VALID in the committed transaction above; validation holds no earlier schema lock.
ALTER TABLE "legal_reader_answer_messages"
  VALIDATE CONSTRAINT "legal_reader_answer_messages_sequence_not_null";--> statement-breakpoint

-- Keep metadata promotion and removal of its proof in one retryable transaction.
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint

-- The validated check proves NOT NULL without an ACCESS EXCLUSIVE table scan.
-- squawk-ignore adding-not-nullable-field -- The validated sequence_not_null check supplies PostgreSQL's scan-free proof.
ALTER TABLE "legal_reader_answer_messages" ALTER COLUMN "sequence" SET NOT NULL;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Removes only the temporary validation proof after equivalent NOT NULL metadata is enforced.
ALTER TABLE "legal_reader_answer_messages"
  DROP CONSTRAINT IF EXISTS "legal_reader_answer_messages_sequence_not_null";--> statement-breakpoint

-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint

SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- The online phase validates and repairs interrupted builds before retiring
-- the previous chronological index. Retries retain an already-valid unique index.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "legal_reader_answer_messages_answer_sequence_idx"
  ON "legal_reader_answer_messages" ("answer_id", "sequence");--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- Reopen the migrator transaction for its bookkeeping row.
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
