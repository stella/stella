-- requires: 20260925220000_legal_list_verifications
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Replace the error-code CHECK with the same lifecycle invariant and a superset of accepted codes in one transaction.
ALTER TABLE "legal_list_verification_runs"
  DROP CONSTRAINT "legal_list_verification_runs_error_code_check";
--> statement-breakpoint
ALTER TABLE "legal_list_verification_runs"
  ADD CONSTRAINT "legal_list_verification_runs_error_code_check"
  CHECK (("status" = 'failed') = ("error_code" IS NOT NULL)
    AND ("error_code" IS NULL OR "error_code" IN (
      'pin_unresolved', 'pin_content_changed', 'unsupported_format', 'no_text',
      'ai_unavailable', 'extraction_failed', 'grading_failed', 'enqueue_failed',
      'access_revoked', 'internal'
    ))) NOT VALID;
--> statement-breakpoint
