SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "case_law_decision_identifiers" (
  "decision_id" uuid NOT NULL,
  "type" varchar(32) NOT NULL,
  "value" varchar(256) NOT NULL,
  "normalized_value" varchar(256) NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_decision_identifiers_pk"
    PRIMARY KEY ("decision_id", "type", "normalized_value"),
  CONSTRAINT "case_law_decision_identifiers_decision_id_fk"
    FOREIGN KEY ("decision_id")
    REFERENCES "case_law_decisions"("id")
    ON DELETE CASCADE,
  CONSTRAINT "case_law_decision_identifiers_type_values"
    CHECK ("type" IN (
      'case-number',
      'ecli',
      'neutral-citation',
      'reporter-citation'
    )),
  CONSTRAINT "case_law_decision_identifiers_value_non_empty"
    CHECK ("value" <> '' AND "normalized_value" <> '')
);--> statement-breakpoint

CREATE INDEX "case_law_decision_identifiers_lookup_idx"
  ON "case_law_decision_identifiers" (
    "type",
    "normalized_value",
    "decision_id"
  );--> statement-breakpoint

ALTER TABLE "case_law_citations"
  ADD COLUMN "identifier_type" varchar(32),
  ADD COLUMN "normalized_identifier_value" varchar(256),
  ADD CONSTRAINT "citations_identifier_shape"
    CHECK (
      ("identifier_type" IS NULL) = ("normalized_identifier_value" IS NULL)
      AND "normalized_identifier_value" <> ''
    ) NOT VALID,
  ADD CONSTRAINT "citations_identifier_type_values"
    CHECK ("identifier_type" IN (
      'case-number',
      'ecli',
      'neutral-citation',
      'reporter-citation'
    )) NOT VALID;--> statement-breakpoint

ALTER TABLE "case_law_decision_identifiers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "case_law_decision_identifiers"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access"
  ON "case_law_decision_identifiers"
  AS PERMISSIVE FOR SELECT TO stella
  USING (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access"
  ON "case_law_decision_identifiers"
  AS PERMISSIVE FOR SELECT TO stella_public_law_reader
  USING (true);--> statement-breakpoint

GRANT SELECT ON TABLE "case_law_decision_identifiers" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_decision_identifiers" TO stella_ingestion;--> statement-breakpoint
GRANT SELECT (
  decision_id,
  type,
  value,
  normalized_value,
  created_at
) ON TABLE "case_law_decision_identifiers"
  TO stella_public_law_reader;--> statement-breakpoint

-- Validate the existing citation corpus without holding the migration
-- transaction's table lock, then build its lookup index online.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint

-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
ALTER TABLE "case_law_citations"
  VALIDATE CONSTRAINT "citations_identifier_shape";--> statement-breakpoint
ALTER TABLE "case_law_citations"
  VALIDATE CONSTRAINT "citations_identifier_type_values";--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - retry cleanup only
-- removes an invalid build of this migration's new index.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_citations_reopenable_identifier_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_citations_reopenable_identifier_idx"
  ON "case_law_citations" (
    "identifier_type",
    "normalized_identifier_value"
  )
  WHERE "resolution_status" IN ('unmatched', 'ambiguous');--> statement-breakpoint

SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
