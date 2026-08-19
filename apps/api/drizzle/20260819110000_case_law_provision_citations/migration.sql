-- SET LOCAL, not SET: the migrator runs every pending migration on one
-- connection inside one transaction, so a session-level setting here would
-- outlive this file and silently govern whatever runs after it.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "case_law_provision_citations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "decision_id" uuid NOT NULL,
  "jurisdiction" varchar(3) NOT NULL,
  "work_identifier" text NOT NULL,
  "work_number" integer NOT NULL,
  "work_year" smallint NOT NULL,
  "work_collection" text NOT NULL,
  "work_eli" text,
  "unit" text NOT NULL,
  "section" integer NOT NULL,
  "section_suffix" text,
  "subsection" text,
  "letter" text,
  "point" text,
  "sentence" text,
  "open_ended" boolean DEFAULT false NOT NULL,
  "anchor" text NOT NULL,
  "version_valid_from" date,
  "decision_date" date,
  "sentence_text" text NOT NULL,
  "span_start" integer NOT NULL,
  "span_end" integer NOT NULL,
  "work_source" text,
  "confidence" numeric(3, 2) NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "case_law_provision_citations"
  ADD CONSTRAINT "case_law_provision_citations_decision_fk"
  FOREIGN KEY ("decision_id") REFERENCES "public"."case_law_decisions"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint

-- Added validating, not NOT VALID + VALIDATE: the table is created empty in
-- this same migration, so each scan is over no rows.
ALTER TABLE "case_law_provision_citations"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "provision_citations_unit_values"
  CHECK ("unit" IN ('section','article'));--> statement-breakpoint

ALTER TABLE "case_law_provision_citations"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "provision_citations_work_source_values"
  CHECK (
    "work_source" IS NULL
    OR "work_source" IN ('number','alias','title','definition','carry-over')
  );--> statement-breakpoint

ALTER TABLE "case_law_provision_citations"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "provision_citations_span_order"
  CHECK ("span_end" > "span_start");--> statement-breakpoint

ALTER TABLE "case_law_provision_citations"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "provision_citations_confidence_range"
  CHECK ("confidence" > 0 AND "confidence" <= 1);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "case_law_provision_citations_decision_span_idx"
  ON "case_law_provision_citations" ("decision_id", "span_start", "anchor");--> statement-breakpoint

-- Both reads of "who cites this provision" are keyset walks newest-first,
-- so the date is on the row and in the index rather than on the joined
-- decision: the index answers the page, and the cursor stays stable while
-- the decision's own columns are refreshed.
CREATE INDEX IF NOT EXISTS "case_law_provision_citations_work_idx"
  ON "case_law_provision_citations" (
    "jurisdiction", "work_identifier",
    (coalesce("decision_date", '0001-01-01'::date)) DESC, "decision_id" DESC, "span_start" DESC, "anchor" DESC
  );--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "case_law_provision_citations_work_anchor_idx"
  ON "case_law_provision_citations" (
    "jurisdiction", "work_identifier", "anchor",
    (coalesce("decision_date", '0001-01-01'::date)) DESC, "decision_id" DESC, "span_start" DESC
  );--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "case_law_provision_citations_decision_idx"
  ON "case_law_provision_citations" ("decision_id");--> statement-breakpoint

ALTER TABLE "case_law_provision_citations"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "case_law_global_access" ON "case_law_provision_citations" AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_provision_citations" AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint

-- RLS restricts rows, grants restrict verbs — both are needed.
GRANT SELECT ON TABLE "case_law_provision_citations" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "case_law_provision_citations" TO stella_ingestion;
