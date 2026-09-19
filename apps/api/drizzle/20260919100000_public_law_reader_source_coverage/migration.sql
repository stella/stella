SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The public coverage page states, per court feed, whether it is still
-- running, when it last ran, and how much the publisher says it holds. Keep
-- the constrained reader's column grant aligned with that read. The cursor,
-- the lease and the feed's own configuration stay ungranted.
GRANT SELECT (enabled, last_sync_at, reported_total, reported_total_as_of, reported_total_origin)
  ON TABLE "case_law_sources"
  TO stella_public_law_reader;
