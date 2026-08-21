SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- One pass of the citation-resolution census. A run walks precedent
-- citations for its status and rule counts (cursor_citing_decision_id,
-- cursor_citation_id), then ambiguous keys for their shapes (cursor_key);
-- both walks are keyset-bounded and resume, so a run that stops at its
-- per-invocation bound is continued, not restarted. Both walks read only
-- rows last settled at or before started_at; status says which walk a
-- reader is looking at.
CREATE TABLE IF NOT EXISTS "case_law_citation_resolution_census_runs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "status" text NOT NULL,
  "started_at" timestamptz DEFAULT now() NOT NULL,
  "finished_at" timestamptz,
  "keys_scanned" integer DEFAULT 0 NOT NULL,
  "cursor_citing_decision_id" uuid,
  "cursor_citation_id" uuid,
  "cursor_key" varchar(128),
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Added validating, not NOT VALID + VALIDATE: the table is created empty in
-- this same migration, so each scan is over no rows.
ALTER TABLE "case_law_citation_resolution_census_runs"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "case_law_citation_resolution_census_runs_status_values"
  CHECK ("status" IN ('scanning-baseline', 'scanning-shapes', 'complete'));--> statement-breakpoint

ALTER TABLE "case_law_citation_resolution_census_runs"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "case_law_citation_resolution_census_runs_finished_pair"
  CHECK (("finished_at" IS NULL) = ("status" <> 'complete'));--> statement-breakpoint

-- The baseline keyset is a pair; half of one names no citation, so a resumed
-- walk could not tell where it stopped.
ALTER TABLE "case_law_citation_resolution_census_runs"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "case_law_citation_resolution_census_runs_cursor_pair"
  CHECK (("cursor_citing_decision_id" IS NULL) = ("cursor_citation_id" IS NULL));--> statement-breakpoint

-- At most one run is open at a time, so two overlapping invocations cannot
-- each start a walk over the same population.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX IF NOT EXISTS "case_law_citation_resolution_census_runs_open_uidx"
  ON "case_law_citation_resolution_census_runs" ((true))
  WHERE "status" <> 'complete';--> statement-breakpoint

-- Built plainly, not CONCURRENTLY: the table is empty and unread.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS "case_law_citation_resolution_census_runs_started_idx"
  ON "case_law_citation_resolution_census_runs" ("started_at");--> statement-breakpoint

-- One counted population of one run: precedent citations from decisions of
-- (country, court), split by kind into a status, the rule that resolved
-- them, or the shape of an ambiguous key's holders.
CREATE TABLE IF NOT EXISTS "case_law_citation_resolution_census" (
  "run_id" uuid NOT NULL,
  "country" varchar(3) NOT NULL,
  "court" text NOT NULL,
  "kind" text NOT NULL,
  "bucket" varchar(32) NOT NULL,
  "keys" integer DEFAULT 0 NOT NULL,
  "citations" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "case_law_citation_resolution_census_pk"
    PRIMARY KEY ("run_id", "country", "court", "kind", "bucket")
);--> statement-breakpoint

ALTER TABLE "case_law_citation_resolution_census"
  ADD CONSTRAINT "case_law_citation_resolution_census_run_fk"
  FOREIGN KEY ("run_id") REFERENCES "public"."case_law_citation_resolution_census_runs"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint

ALTER TABLE "case_law_citation_resolution_census"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "case_law_citation_resolution_census_kind_values"
  CHECK ("kind" IN ('status', 'rule', 'shape'));--> statement-breakpoint

-- The bucket vocabulary follows the kind.
ALTER TABLE "case_law_citation_resolution_census"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "case_law_citation_resolution_census_bucket_values"
  CHECK (
    ("kind" = 'status' AND "bucket" IN ('pending', 'resolved', 'unmatched', 'ambiguous'))
    OR ("kind" = 'rule' AND "bucket" IN ('unique-key', 'type-hint', 'one-file-merits', 'unattributed'))
    OR ("kind" = 'shape' AND "bucket" IN ('at-cap', 'cross-court', 'untyped', 'one-file-merits', 'orders-only', 'merits-only', 'other'))
  );--> statement-breakpoint

ALTER TABLE "case_law_citation_resolution_census_runs"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_citation_resolution_census"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Same access shape as the resolution progress row: the app role reads it
-- for the ingestion status rollup, only background writers fill it.
CREATE POLICY "case_law_global_access" ON "case_law_citation_resolution_census_runs" AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_citation_resolution_census_runs" AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access" ON "case_law_citation_resolution_census" AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_citation_resolution_census" AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint

-- RLS restricts rows, grants restrict verbs — both are needed.
GRANT SELECT ON TABLE "case_law_citation_resolution_census_runs" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "case_law_citation_resolution_census_runs" TO stella_ingestion;--> statement-breakpoint
GRANT SELECT ON TABLE "case_law_citation_resolution_census" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "case_law_citation_resolution_census" TO stella_ingestion;
