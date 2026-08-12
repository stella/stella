SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A run now names who carries it to a terminal state: the document-review
-- queue worker, or the files-table property DAG that grades the same document
-- through its verdict columns. A document holds at most one active run, so
-- without the discriminator the table path could commit findings into a review
-- a person started from the inspector, and vice versa.
--
-- Every existing run was executed by the worker, which is the default, so the
-- column lands NOT NULL with no backfill.
ALTER TABLE "document_review_runs"
  ADD COLUMN IF NOT EXISTS "executor" text DEFAULT 'worker' NOT NULL;--> statement-breakpoint

-- Added validating rather than NOT VALID + VALIDATE. The table is days old and
-- holds one row per review, so the scan is trivial; and the migrator wraps a
-- migration in one transaction, so the split form would hold its locks to
-- commit anyway.
ALTER TABLE "document_review_runs"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "document_review_runs_executor_values_check"
  CHECK ("executor" IN ('worker', 'table'));
