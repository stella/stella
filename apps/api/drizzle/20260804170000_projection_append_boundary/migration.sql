SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Records the moment a reservation crosses the external append boundary.
-- Only the append reservation sets it; the projection trigger never does.
-- Its absence, together with no committed copy (index_id IS NULL), is what
-- proves a pending row has never reached the engine, so the backfill can
-- append it without first issuing a delete — a delete rewrites the engine's
-- whole manifest, and paying that per never-indexed row made a backlog
-- drain's cost quadratic.
ALTER TABLE "case_law_corpus_index_projections"
  ADD COLUMN IF NOT EXISTS "append_reserved_at" timestamptz;--> statement-breakpoint
