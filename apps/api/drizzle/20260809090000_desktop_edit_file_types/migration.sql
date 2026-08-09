SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

ALTER TABLE "desktop_edit_sessions"
  ADD COLUMN "file_type" text DEFAULT 'docx' NOT NULL;--> statement-breakpoint

ALTER TABLE "desktop_edit_sessions"
  ALTER COLUMN "file_type" DROP DEFAULT;--> statement-breakpoint

ALTER TABLE "desktop_edit_sessions"
  ADD CONSTRAINT "desktop_edit_sessions_file_type_check"
  CHECK ("file_type" IN ('docx', 'xlsx', 'pptx')) NOT VALID;--> statement-breakpoint

ALTER TABLE "desktop_edit_sessions"
  VALIDATE CONSTRAINT "desktop_edit_sessions_file_type_check";
