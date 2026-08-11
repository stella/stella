SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The count a publisher reports holding, so held-vs-total coverage is
-- computable for sources that expose no cheap public count. Nullable adds
-- with no default: the columns start empty and are filled by the single
-- writer, which polls the adapter where one exposes a total and otherwise
-- takes an operator-supplied number.
ALTER TABLE "case_law_sources"
  ADD COLUMN IF NOT EXISTS "reported_total" integer,
  ADD COLUMN IF NOT EXISTS "reported_total_as_of" timestamptz,
  ADD COLUMN IF NOT EXISTS "reported_total_origin" varchar(16);--> statement-breakpoint

-- The three columns are one fact and move together; a partial trio is a
-- total with no provenance, or a provenance with no total. The writer
-- validates the number before it is stored, and these checks keep any other
-- path (a correction, a later query) from leaving the fact half-written,
-- half-dated, or attributed to an origin the code cannot read back.
--
-- Added validating, not NOT VALID + VALIDATE. This table holds one row per
-- adapter key in the code-defined registry, so the scan is bounded by that
-- registry rather than by corpus size. The two-step form would not help
-- here in any case: the migrator wraps a migration in one transaction, so
-- the locks a split is meant to release are held to commit regardless.
ALTER TABLE "case_law_sources"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "case_law_sources_reported_total_trio"
  CHECK (
    ("reported_total" IS NULL) = ("reported_total_as_of" IS NULL)
    AND ("reported_total" IS NULL) = ("reported_total_origin" IS NULL)
  );--> statement-breakpoint

ALTER TABLE "case_law_sources"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "case_law_sources_reported_total_positive"
  CHECK ("reported_total" IS NULL OR "reported_total" > 0);--> statement-breakpoint

ALTER TABLE "case_law_sources"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "case_law_sources_reported_total_origin_allowed"
  CHECK (
    "reported_total_origin" IS NULL
    OR "reported_total_origin" IN ('adapter-poll', 'operator')
  );--> statement-breakpoint

-- The ingestion role's UPDATE on this table is column-scoped, so the poll and
-- the operator set both write through it only if these three columns are
-- named. Without the grant every write is rejected. Drizzle's $onUpdate also
-- touches updated_at, which the role already holds.
GRANT UPDATE (reported_total, reported_total_as_of, reported_total_origin)
  ON TABLE "case_law_sources"
  TO stella_ingestion;
