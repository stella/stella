-- requires: 20260924140000_case_law_citation_reviews
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Every review stored so far was written by the operator script, which took
-- an operator's assertion and recorded no model provenance, so existing rows
-- are human reviews. The default exists only to fill them without a rewrite;
-- it is dropped below, so every later writer has to name its origin.
ALTER TABLE "case_law_citation_reviews"
  ADD COLUMN "origin" text DEFAULT 'human-review' NOT NULL,
  ADD COLUMN "model" text,
  ADD COLUMN "prompt_version" text,
  ADD COLUMN "prompt_sha256" varchar(64),
  ADD COLUMN "evidence_sha256" varchar(64),
  ADD COLUMN "run_id" text,
  ADD COLUMN "produced_at" timestamptz;--> statement-breakpoint

ALTER TABLE "case_law_citation_reviews"
  ALTER COLUMN "origin" DROP DEFAULT;--> statement-breakpoint

-- Derived from CITATION_REVIEW_ORIGINS. Validated in the next migration.
ALTER TABLE "case_law_citation_reviews"
  ADD CONSTRAINT "citation_reviews_origin_values"
  CHECK ("origin" IN ('human-review', 'ai-adjudicated', 'ai-annotation'))
  NOT VALID;--> statement-breakpoint

-- Model provenance is present exactly when a model produced the label.
ALTER TABLE "case_law_citation_reviews"
  ADD CONSTRAINT "citation_reviews_origin_provenance"
  CHECK (
    ("origin" IN ('human-review')
      AND "model" IS NULL AND "prompt_version" IS NULL
      AND "prompt_sha256" IS NULL AND "evidence_sha256" IS NULL
      AND "run_id" IS NULL AND "produced_at" IS NULL)
    OR ("origin" IN ('ai-adjudicated', 'ai-annotation')
      AND "model" IS NOT NULL AND "prompt_version" IS NOT NULL
      AND "prompt_sha256" IS NOT NULL AND "evidence_sha256" IS NOT NULL
      AND "run_id" IS NOT NULL AND "produced_at" IS NOT NULL)
  )
  NOT VALID;
