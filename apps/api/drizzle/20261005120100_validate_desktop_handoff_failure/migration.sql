-- requires: 20261005120000_desktop_handoff_failure
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "desktop_edit_handoffs" VALIDATE CONSTRAINT "desktop_edit_handoffs_failure_check";--> statement-breakpoint
ALTER TABLE "pdf_signing_sessions" VALIDATE CONSTRAINT "pdf_signing_sessions_close_reason_check";
