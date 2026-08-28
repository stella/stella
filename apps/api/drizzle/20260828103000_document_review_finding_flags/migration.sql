SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- Reviewer flags on a review finding, in the same words the files table's cell
-- flags already use. A flag is not a disposition: accept and dismiss stay the
-- tracked-change verbs and keep their own columns; this is the triage a
-- reviewer puts beside them.
--
-- The default is a constant, so the rewrite is metadata-only and no existing
-- row is read.
ALTER TABLE "document_review_findings"
  ADD COLUMN "flags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint

-- Derived from the same value list the column's Drizzle enum is (`REVIEW_FLAGS`
-- in @stll/api-contract): the array may hold only flags the vocabulary names,
-- and no more of them than the vocabulary has, since flags are a set.
--
-- Added validating rather than NOT VALID + VALIDATE, for the same reason as the
-- decision CHECKs on this table: every row holds the empty default the column
-- was just created with, so the scan has nothing to read, and the migrator
-- wraps a migration in one transaction, so the split form would hold its locks
-- to commit anyway.
ALTER TABLE "document_review_findings"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "document_review_findings_flags_values_check"
  CHECK (
    "flags" <@ ARRAY['needs-review', 'important', 'follow-up', 'contradiction', 'verified']::text[]
    AND cardinality("flags") <= 5
  );
