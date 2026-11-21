SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "desktop_edit_handoffs" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "desktop_edit_handoffs" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "desktop_edit_handoffs" ADD CONSTRAINT "desktop_edit_handoffs_failure_check" CHECK (("failed_at" IS NULL AND "failure_reason" IS NULL) OR ("failed_at" IS NOT NULL AND "consumed_at" IS NULL AND "opened_at" IS NULL AND "failure_reason" IS NOT NULL AND "failure_reason" IN ('desktop_update_required', 'desktop_account_required'))) NOT VALID;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Replaces the close-reason CHECK in the same transaction, preserving all existing values and adding desktop acknowledgement reasons. A failed migration rolls back both statements.
ALTER TABLE "pdf_signing_sessions" DROP CONSTRAINT "pdf_signing_sessions_close_reason_check";--> statement-breakpoint
ALTER TABLE "pdf_signing_sessions" ADD CONSTRAINT "pdf_signing_sessions_close_reason_check" CHECK ("close_reason" IS NULL OR "close_reason" IN ('desktop_update_required', 'desktop_account_required', 'user_cancelled', 'base_version_diverged', 'digest_mismatch', 'unsupported_platform', 'certificate_rejected', 'certificate_revoked', 'certified_document', 'expired', 'signature_invalid', 'signing_failed', 'stamp_overflow', 'stamp_unrenderable', 'would_break_signatures')) NOT VALID;
