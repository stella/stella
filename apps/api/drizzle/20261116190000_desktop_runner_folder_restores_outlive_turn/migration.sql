SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- An edit from a message removes the turns after it, the turn whose files an
-- undo put back among them. The restore outlives that turn, so the next run
-- of the chat is still told the folder went back: the turn reference is
-- cleared instead of the row going with the turn. The thread and run keep the
-- row as before.
-- squawk-ignore ban-drop-not-null -- A restore whose turn an edit removed keeps no turn.
ALTER TABLE "desktop_runner_folder_restores" ALTER COLUMN "chat_turn_id" DROP NOT NULL;--> statement-breakpoint

-- Dropped by name and re-added in one statement, so no running API task sees
-- the column without a reference. Only the delete action changes; every
-- stored row already references an existing turn, and the table holds a few
-- rows per member, so validating it reads them within the timeouts above.
-- stella-migration-safety: reviewed drop-constraint - drops only this foreign key by name and re-adds it on the same column with ON DELETE set null in the same statement; no row data is touched. Rollback is the same statement with ON DELETE cascade, once no row holds a null turn.
ALTER TABLE "desktop_runner_folder_restores"
  DROP CONSTRAINT IF EXISTS "desktop_runner_folder_restores_chat_turn_fk",
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "desktop_runner_folder_restores_chat_turn_fk"
  FOREIGN KEY ("chat_turn_id") REFERENCES "chat_turns"("id") ON DELETE set null;
