SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Constant defaults use the catalog fast path; existing rows are not rewritten.
ALTER TABLE "style_sets"
  ADD COLUMN "deletion_cleanup_attempt_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "deletion_cleanup_next_attempt_at" timestamptz;
--> statement-breakpoint

-- New writes obey the check at once; the online phase validates existing rows.
ALTER TABLE "style_sets"
  ADD CONSTRAINT "style_sets_deletion_cleanup_attempt_count_nonnegative_check"
  CHECK ("deletion_cleanup_attempt_count" >= 0) NOT VALID;
