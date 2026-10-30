SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "legislation_amendment_snapshots" (
  "source_id" uuid NOT NULL,
  "target_eli" varchar(512) NOT NULL,
  "language" varchar(16) NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "coverage" jsonb NOT NULL,
  CONSTRAINT "legislation_amendment_snapshots_pk" PRIMARY KEY ("source_id", "target_eli", "language"),
  CONSTRAINT "legislation_amendment_snapshots_source_fk" FOREIGN KEY ("source_id") REFERENCES "legislation_sources"("id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE TABLE "legislation_amendments" (
  "source_id" uuid NOT NULL CONSTRAINT "legislation_amendments_source_id_legislation_sources_id_fk" REFERENCES "legislation_sources"("id") ON DELETE CASCADE,
  "target_eli" varchar(512) NOT NULL,
  "language" varchar(16) NOT NULL,
  "publisher_id" varchar(512) NOT NULL,
  "amending_eli" varchar(512) NOT NULL,
  "amending_title" text,
  "amending_anchor" text,
  "affected_anchor" text NOT NULL,
  "change_kind" text NOT NULL,
  "effective_type" text NOT NULL,
  "effective_date" date,
  "effective_text" text,
  "publisher_instruction" text,
  CONSTRAINT "legislation_amendments_pk" PRIMARY KEY ("source_id", "target_eli", "language", "publisher_id"),
  CONSTRAINT "legislation_amendments_kind" CHECK ("change_kind" IN ('changed', 'inserted', 'repealed')),
  CONSTRAINT "legislation_amendments_effective" CHECK (
    ("effective_type" = 'date' AND "effective_date" IS NOT NULL AND "effective_text" IS NULL)
    OR ("effective_type" = 'not-stated' AND "effective_date" IS NULL)
  ),
  CONSTRAINT "legislation_amendments_identity" CHECK ("publisher_id" <> '' AND "amending_eli" <> '' AND "affected_anchor" <> '')
);--> statement-breakpoint
CREATE INDEX "legislation_amendments_amending_idx" ON "legislation_amendments" ("source_id", "amending_eli", "language", "target_eli", "publisher_id");--> statement-breakpoint
CREATE INDEX "legislation_amendments_target_date_idx" ON "legislation_amendments" ("source_id", "target_eli", "language", "effective_date", "publisher_id");--> statement-breakpoint

ALTER TABLE "legislation_amendment_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legislation_amendment_snapshots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_global_access" ON "legislation_amendment_snapshots" FOR SELECT TO stella USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "legislation_amendment_snapshots" FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "legislation_amendment_snapshots" FOR SELECT TO stella_public_law_reader USING (true);--> statement-breakpoint
ALTER TABLE "legislation_amendments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legislation_amendments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_global_access" ON "legislation_amendments" FOR SELECT TO stella USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "legislation_amendments" FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "legislation_amendments" FOR SELECT TO stella_public_law_reader USING (true);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "legislation_amendment_snapshots", "legislation_amendments" TO stella_ingestion;--> statement-breakpoint
GRANT SELECT ON "legislation_amendment_snapshots", "legislation_amendments" TO stella;--> statement-breakpoint
GRANT SELECT (source_id, target_eli, language, observed_at, coverage) ON TABLE "legislation_amendment_snapshots" TO stella_public_law_reader;--> statement-breakpoint
GRANT SELECT (source_id, target_eli, language, publisher_id, amending_eli, amending_title, amending_anchor, affected_anchor, change_kind, effective_type, effective_date, effective_text, publisher_instruction) ON TABLE "legislation_amendments" TO stella_public_law_reader;--> statement-breakpoint

RESET lock_timeout;--> statement-breakpoint
RESET statement_timeout;
