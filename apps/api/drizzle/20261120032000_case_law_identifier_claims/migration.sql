SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "case_law_decision_identifiers"
  ADD COLUMN "independent_claims" varchar(32)[] NOT NULL DEFAULT '{unverified}'::varchar(32)[];--> statement-breakpoint

ALTER TABLE "case_law_decision_identifiers"
  ADD CONSTRAINT "case_law_decision_identifiers_independent_claims"
  CHECK ("independent_claims" <@ ARRAY['host', 'retired-alias', 'unverified']::varchar[] AND cardinality("independent_claims") <= 3) NOT VALID;
