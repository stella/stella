SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "document_translation_runs"
  ADD COLUMN "comment_policy" text;--> statement-breakpoint

ALTER TABLE "document_translation_runs"
  ADD CONSTRAINT "document_translation_runs_comment_policy_check"
  CHECK (
    "comment_policy" IS NULL
    OR (
      "source_mime_type" = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      AND "comment_policy" IN ('original', 'original-and-translated', 'translated')
    )
  ) NOT VALID;
