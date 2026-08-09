SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

ALTER TABLE "desktop_edit_sessions"
  ADD COLUMN "file_type" text DEFAULT 'docx' NOT NULL;--> statement-breakpoint

-- Mixed-version API deployments still have writers that omit file_type.
-- Remove this default in a later release after every supported writer sets it.

ALTER TABLE "desktop_edit_sessions"
  ADD CONSTRAINT "desktop_edit_sessions_file_type_check"
  CHECK ("file_type" IN ('docx', 'xlsx', 'pptx')) NOT VALID;--> statement-breakpoint

-- Release the ADD CONSTRAINT transaction before scanning existing rows.
-- Validation uses SHARE UPDATE EXCLUSIVE, so normal reads and writes continue.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

ALTER TABLE "desktop_edit_sessions"
  VALIDATE CONSTRAINT "desktop_edit_sessions_file_type_check";
