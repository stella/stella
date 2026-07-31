SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Per-slice crawl coverage: the count a court reports for a slice against
-- what the crawl stored. A partial crawl is otherwise indistinguishable
-- from a quiet day, and a forward-only cursor never revisits, so the loss
-- is silent and permanent. A row per slice makes the shortfall queryable.
CREATE TABLE IF NOT EXISTS "case_law_coverage_slices" (
  "id" uuid PRIMARY KEY NOT NULL,
  "source_id" uuid NOT NULL,
  "slice" varchar(64) NOT NULL,
  "reported" integer NOT NULL,
  "collected" integer NOT NULL,
  "checked_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

-- squawk-ignore prefer-robust-stmts
ALTER TABLE "case_law_coverage_slices"
  ADD CONSTRAINT "case_law_coverage_slices_source_id_case_law_sources_id_fk"
  FOREIGN KEY ("source_id") REFERENCES "public"."case_law_sources"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "case_law_coverage_slices_source_slice_idx"
  ON "case_law_coverage_slices" ("source_id","slice");--> statement-breakpoint

-- The reconciliation pass reads only short slices, so the index covers
-- that arm and shrinks as gaps close.
CREATE INDEX IF NOT EXISTS "case_law_coverage_slices_short_idx"
  ON "case_law_coverage_slices" ("source_id","slice")
  WHERE "collected" < "reported";--> statement-breakpoint

ALTER TABLE "case_law_coverage_slices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Same access shape as every other case-law table: readable by the app
-- role, writable only by ingestion.
CREATE POLICY "case_law_global_access" ON "case_law_coverage_slices" AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_coverage_slices" AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint

-- The app role reads the ledger (coverage reporting); only ingestion
-- writes it. RLS restricts rows, grants restrict verbs — both are needed.
GRANT SELECT ON TABLE "case_law_coverage_slices" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "case_law_coverage_slices" TO stella_ingestion;
