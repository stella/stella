SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A finding gains a reviewer disposition. `open` is the state every finding is
-- born in, so the column lands NOT NULL with that default and no backfill:
-- every existing row is, correctly, undecided.
--
-- A named decision rather than an `accepted` boolean. The set is expected to
-- grow (deferred, escalated, waived), and each addition must force a decision
-- everywhere the value is read instead of silently reading as "not accepted".
ALTER TABLE "document_review_findings"
  ADD COLUMN IF NOT EXISTS "decision" text DEFAULT 'open' NOT NULL,
  ADD COLUMN IF NOT EXISTS "decided_by" text,
  ADD COLUMN IF NOT EXISTS "decided_at" timestamptz;--> statement-breakpoint

-- The decider's account may be removed; the decision and its timestamp must
-- not go with it, so the reference nulls rather than cascades.
-- Added validating for the same reason as the CHECKs below: the table is two
-- days old and tiny, and the migrator's single transaction holds the lock to
-- commit either way, so NOT VALID + VALIDATE buys nothing here.
ALTER TABLE "document_review_findings"
  -- squawk-ignore constraint-missing-not-valid, adding-foreign-key-constraint
  ADD CONSTRAINT "document_review_findings_decided_by_user_id_fk"
  FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Added validating rather than NOT VALID + VALIDATE. The table was created two
-- days ago and holds at most one row per confirmed topic per check kind per
-- run, so the scan is trivial; and the migrator wraps a migration in one
-- transaction, so the split form would hold its locks to commit anyway.
ALTER TABLE "document_review_findings"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "document_review_findings_decision_values_check"
  CHECK ("decision" IN ('open', 'accepted', 'dismissed'));--> statement-breakpoint

-- "Open" and "undecided" are one fact, so they cannot disagree: a decided
-- finding always carries its moment, an open one never does. `decided_by` is
-- outside the rule on purpose — the FK above nulls it when an account is
-- removed, which must not reopen a decided finding.
ALTER TABLE "document_review_findings"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "document_review_findings_decision_timing_check"
  CHECK (("decision" = 'open') = ("decided_at" IS NULL));
