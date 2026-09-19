SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- How many decisions the corpus holds per source, counted on the ingestion
-- side so a public request reads an integer instead of walking the source's
-- index range. Nullable: a source counted for the first time on its next
-- sync cycle reads as uncounted until then, never as holding nothing.
ALTER TABLE "case_law_sources" ADD COLUMN "stored_total" integer;--> statement-breakpoint
ALTER TABLE "case_law_sources" ADD COLUMN "stored_total_as_of" timestamp with time zone;--> statement-breakpoint

-- NOT VALID here, VALIDATE below, for both constraints. A validating CHECK
-- scans every row while holding ACCESS EXCLUSIVE; NOT VALID takes the lock
-- only long enough to record the constraint, which then applies to every
-- later INSERT and UPDATE. This table holds one row per registered adapter,
-- so the scan would be trivial, but the shape is the rule rather than a
-- judgement about size: the next table to copy it may not be small.
-- Dropped first so the file is re-runnable: each ADD commits before its
-- VALIDATE, and a failed VALIDATE would otherwise leave a second run failing
-- on a constraint that already exists.
-- stella-migration-safety: reviewed drop-constraint - Drops only the
-- constraint the next statement re-adds, so a retried migration re-enters the
-- same state; no other constraint and no data is touched.
ALTER TABLE "case_law_sources"
  DROP CONSTRAINT IF EXISTS "case_law_sources_stored_total_pair";--> statement-breakpoint
ALTER TABLE "case_law_sources"
  ADD CONSTRAINT "case_law_sources_stored_total_pair"
  CHECK (("stored_total" IS NULL) = ("stored_total_as_of" IS NULL))
  NOT VALID;--> statement-breakpoint
ALTER TABLE "case_law_sources"
  VALIDATE CONSTRAINT "case_law_sources_stored_total_pair";--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Drops only the
-- constraint the next statement re-adds, so a retried migration re-enters the
-- same state; no other constraint and no data is touched.
ALTER TABLE "case_law_sources"
  DROP CONSTRAINT IF EXISTS "case_law_sources_stored_total_nonnegative";--> statement-breakpoint
ALTER TABLE "case_law_sources"
  ADD CONSTRAINT "case_law_sources_stored_total_nonnegative"
  CHECK ("stored_total" IS NULL OR "stored_total" >= 0)
  NOT VALID;--> statement-breakpoint
ALTER TABLE "case_law_sources"
  VALIDATE CONSTRAINT "case_law_sources_stored_total_nonnegative";--> statement-breakpoint

GRANT SELECT (stored_total, stored_total_as_of)
  ON TABLE "case_law_sources"
  TO stella_public_law_reader;
