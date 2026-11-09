SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- Sources a review run read only in part, because they exceed the model's
-- request budget, so the results can say the document was not read whole.
--
-- The default is a constant, so the rewrite is metadata-only and no existing
-- row is read.
ALTER TABLE "document_review_runs"
  ADD COLUMN "withheld_sources" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

-- A run refused because its documents cannot fit the model fails with its own
-- code, document_too_large. The error code check is replaced by a wider NOT
-- VALID check and validated online.
-- stella-migration-safety: reviewed drop-constraint - the error code check is immediately replaced by a wider NOT VALID check that also accepts document_too_large; every existing row still satisfies it, and it is validated online.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "document_review_runs" DROP CONSTRAINT IF EXISTS "document_review_runs_error_code_values_check";--> statement-breakpoint
ALTER TABLE "document_review_runs" ADD CONSTRAINT "document_review_runs_error_code_values_check"
  CHECK ("error_code" IS NULL OR "error_code" IN (
    'pin_unresolved', 'pin_content_changed', 'unsupported_format',
    'ai_unavailable', 'document_too_large', 'playbook_check_failed',
    'reference_check_failed', 'enqueue_failed', 'internal'
  )) NOT VALID;
