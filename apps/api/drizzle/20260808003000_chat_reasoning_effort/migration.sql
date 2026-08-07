SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "chat_threads"
ADD COLUMN IF NOT EXISTS "chat_reasoning_effort" text;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chat_threads_reasoning_effort_selection_check'
      AND conrelid = 'chat_threads'::regclass
  ) THEN
    ALTER TABLE "chat_threads"
    ADD CONSTRAINT "chat_threads_reasoning_effort_selection_check"
    CHECK (
      "chat_reasoning_effort" IS NULL
      OR (
        "chat_model" IS NOT NULL
        AND "chat_reasoning_effort" IN (
          'none',
          'minimal',
          'low',
          'medium',
          'high',
          'xhigh',
          'max'
        )
      )
    ) NOT VALID;
  END IF;
END
$$;--> statement-breakpoint

-- Release the ADD CONSTRAINT transaction's ACCESS EXCLUSIVE lock before
-- scanning existing rows. Validation uses SHARE UPDATE EXCLUSIVE, so normal
-- chat reads and writes can continue during the scan.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "chat_threads"
VALIDATE CONSTRAINT "chat_threads_reasoning_effort_selection_check";
