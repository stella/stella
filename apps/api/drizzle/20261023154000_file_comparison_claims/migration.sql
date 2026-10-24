SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Additive claim metadata lets one request lease both inputs without holding
-- a transaction open across object reads, security scans, or DOCX comparison.
-- Older tasks ignore the nullable columns and already refuse the new status.
ALTER TABLE "file_comparison_uploads"
  ADD COLUMN "claim_id" uuid,
  ADD COLUMN "claim_expires_at" timestamptz;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - the next statement
-- re-adds the status check in the same transaction with one more allowed
-- value, so no row escapes it; rollback re-adds the old list once no row is
-- 'processing'.
ALTER TABLE "file_comparison_uploads"
  DROP CONSTRAINT "file_comparison_uploads_status_check";--> statement-breakpoint

ALTER TABLE "file_comparison_uploads"
  ADD CONSTRAINT "file_comparison_uploads_status_check"
    CHECK ("status" in ('pending', 'ready', 'processing', 'consumed', 'failed')),
  ADD CONSTRAINT "file_comparison_uploads_claim_check"
    CHECK (
      ("status" = 'processing') =
      ("claim_id" IS NOT NULL AND "claim_expires_at" IS NOT NULL)
    );
