SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "case_law_decision_source_identities"
  ADD COLUMN "source_raw_s3_key" varchar(512),
  ADD COLUMN "source_raw_content_type" varchar(128),
  ADD COLUMN "source_url" varchar(2048),
  ADD COLUMN "source_observed_at" timestamptz;

CREATE INDEX "case_law_decisions_republished_ruling_idx"
  ON "case_law_decisions" ("country", "court", "docket_family_key", "id")
  WHERE "docket_family_key" IS NOT NULL;
