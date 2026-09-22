SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Admit 'listing-census' as a reported-total origin: a total summed from what
-- the publisher lists slice by slice, for a source whose publisher states no
-- count. The CHECK spells the accepted list, so it is replaced rather than
-- added to.
--
-- Validating in the same statement, as the constraint was first added: this
-- table holds one row per adapter key in the code-defined registry, so the
-- scan is bounded by that registry rather than by corpus size.
--
-- stella-migration-safety: reviewed drop-constraint - the same statement adds
-- back a CHECK over a strict superset of the accepted origins, so every
-- existing row satisfies it and a running task keeps writing the origins it
-- knows; rollback restores the prior CHECK once no row carries the new origin.
ALTER TABLE "case_law_sources"
  DROP CONSTRAINT IF EXISTS "case_law_sources_reported_total_origin_allowed",
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "case_law_sources_reported_total_origin_allowed"
  CHECK (
    "reported_total_origin" IS NULL
    OR "reported_total_origin" IN ('adapter-poll', 'listing-census', 'operator')
  );
