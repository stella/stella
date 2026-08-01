SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Ordered ingestion owns only its two source progress counters in addition to
-- the pre-existing cursor columns. Keep the role column-scoped.
GRANT UPDATE (observation_order, checkpoint_observation_order)
  ON TABLE "case_law_sources"
  TO stella_ingestion;--> statement-breakpoint
