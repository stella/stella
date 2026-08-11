SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The count a publisher reports holding, so held-vs-total coverage is
-- computable for sources that expose no cheap public count. Nullable adds
-- with no default: the columns start empty and are filled by the single
-- writer, which polls the adapter where one exposes a total and otherwise
-- takes an operator-supplied number.
ALTER TABLE "case_law_sources"
  ADD COLUMN IF NOT EXISTS "reported_total" integer;--> statement-breakpoint
ALTER TABLE "case_law_sources"
  ADD COLUMN IF NOT EXISTS "reported_total_as_of" timestamptz;--> statement-breakpoint

-- Provenance of the number ('adapter-poll' or 'operator'), not a boolean:
-- a further origin must be able to land as a new value. The trio moves
-- together (all set or all null); that is the writer's invariant, since the
-- writer is also what validates the number itself.
ALTER TABLE "case_law_sources"
  ADD COLUMN IF NOT EXISTS "reported_total_origin" varchar(16);
