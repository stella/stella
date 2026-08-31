SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- A review fix is a Folio suggestion, not a second kind of change. Completing a
-- run stages one suggestion per finding that carries a fix, and resolving that
-- suggestion is what resolves the finding, so the two rows need a link.
ALTER TABLE "docx_suggestions"
  ADD COLUMN "origin_review_finding_id" uuid;--> statement-breakpoint

-- SET NULL rather than CASCADE: a tracked change already inserted into a
-- document must not disappear because the finding that proposed it was.
ALTER TABLE "docx_suggestions"
  ADD CONSTRAINT "docx_suggestions_origin_review_finding_fk"
  FOREIGN KEY ("origin_review_finding_id")
  REFERENCES "document_review_findings"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;--> statement-breakpoint

-- One suggestion per finding, which is what makes re-finalizing a run converge
-- instead of staging the same redline twice.
--
-- Built inside the migrator transaction on purpose: the ADD COLUMN above
-- already holds ACCESS EXCLUSIVE on this table, so a concurrent build could not
-- shorten the lock window — it would only split the transaction and allow a
-- failed retry to leave the column present without the uniqueness the staging
-- insert's ON CONFLICT depends on.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "docx_suggestions_origin_review_finding_uidx"
  ON "docx_suggestions" ("origin_review_finding_id")
  WHERE "origin_review_finding_id" IS NOT NULL;
