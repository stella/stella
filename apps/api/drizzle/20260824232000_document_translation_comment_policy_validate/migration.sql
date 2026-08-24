SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "document_translation_runs"
  VALIDATE CONSTRAINT "document_translation_runs_comment_policy_check";
