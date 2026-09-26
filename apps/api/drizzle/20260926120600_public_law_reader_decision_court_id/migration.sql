SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The public search ranks a decision whose jurisdiction stores a directory
-- court id by that id. Keep the constrained reader's column grant aligned
-- with that read.
GRANT SELECT (court_id)
  ON TABLE "case_law_decisions"
  TO stella_public_law_reader;
