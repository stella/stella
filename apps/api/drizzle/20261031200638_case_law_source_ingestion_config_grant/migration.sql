-- requires: 20261027160200_case_law_removal_snapshots
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Ingestion records per-item unavailable streaks under config.unavailableItems
-- in the lease-fenced cursor write; the role held SELECT on config but no UPDATE.
-- A column grant covers the whole config document (Postgres cannot grant a
-- JSON path), so the ingestion role is trusted with every key in it.
GRANT UPDATE ("config") ON TABLE "case_law_sources" TO stella_ingestion;
