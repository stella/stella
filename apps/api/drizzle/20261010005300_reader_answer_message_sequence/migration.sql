-- requires: 20261010005200_reader_answer_message_diagnostics
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "legal_reader_answer_messages" ADD COLUMN "sequence" integer;--> statement-breakpoint

-- Preserve the previous canonical order for existing feature rows before the new writer starts.
WITH ordered AS (
  SELECT "id", row_number() OVER (PARTITION BY "answer_id" ORDER BY "created_at", "id") AS "sequence"
  FROM "legal_reader_answer_messages"
)
UPDATE "legal_reader_answer_messages" AS message
SET "sequence" = ordered."sequence"::integer
FROM ordered
WHERE message."id" = ordered."id" AND message."sequence" IS NULL;--> statement-breakpoint

ALTER TABLE "legal_reader_answer_messages" ALTER COLUMN "sequence" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_reader_answer_messages"
  ADD CONSTRAINT "legal_reader_answer_messages_sequence_positive" CHECK ("sequence" > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "legal_reader_answer_messages"
  VALIDATE CONSTRAINT "legal_reader_answer_messages_sequence_positive";--> statement-breakpoint
CREATE UNIQUE INDEX "legal_reader_answer_messages_answer_sequence_idx"
  ON "legal_reader_answer_messages" ("answer_id", "sequence");--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - The unique answer-sequence index replaces this unreleased feature index; chronological order is preserved in sequence by the backfill above.
DROP INDEX "legal_reader_answer_messages_answer_idx";
