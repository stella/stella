SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "case_law_held_decision_attachments"
  ADD COLUMN "match_evidence" jsonb,
  ADD COLUMN "document_part" jsonb,
  ADD COLUMN "document_body_s3_key" varchar(512),
  ADD COLUMN "document_body_sha256" varchar(64);--> statement-breakpoint

ALTER TABLE "case_law_held_decision_attachments"
  ADD CONSTRAINT "case_law_held_decision_attachments_document_shape"
  CHECK (
    ("document_body_s3_key" IS NULL) = ("document_body_sha256" IS NULL)
    AND (
      "document_body_s3_key" IS NULL
      OR (
        "document_part" IS NOT NULL
        AND "host_decision_id" IS NOT NULL
        AND "host_withdrawn_at" IS NULL
        AND ("match_evidence"->>'status') IS NOT DISTINCT FROM 'matched'
      )
    )
    AND (
      "host_withdrawn_at" IS NULL
      OR (
        "document_part" IS NULL
        AND "document_body_s3_key" IS NULL
        AND "document_body_sha256" IS NULL
      )
    )
  ) NOT VALID;

--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Replaces only the match-basis check with a strict superset admitting an explicit source-policy review.
ALTER TABLE "case_law_held_decision_attachments"
  DROP CONSTRAINT "case_law_held_decision_attachments_basis_values";--> statement-breakpoint
ALTER TABLE "case_law_held_decision_attachments"
  ADD CONSTRAINT "case_law_held_decision_attachments_basis_values"
  CHECK ("match_basis" IN ('ecli', 'court-docket-date', 'court-docket-other-date', 'source-policy')) NOT VALID;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Replaces only the review shape with the same no-host invariant for the newly admitted source-policy basis.
ALTER TABLE "case_law_held_decision_attachments"
  DROP CONSTRAINT "case_law_held_decision_attachments_review_shape";--> statement-breakpoint
ALTER TABLE "case_law_held_decision_attachments"
  ADD CONSTRAINT "case_law_held_decision_attachments_review_shape"
  CHECK ("match_basis" NOT IN ('court-docket-other-date', 'source-policy') OR "host_decision_id" IS NULL) NOT VALID;
