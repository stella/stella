SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The public search resolves an entry that names a decision by its canonical
-- citation key instead of searching the text index for it. Keep the
-- constrained reader's column grant aligned with that read.
GRANT SELECT (citation_key)
  ON TABLE "case_law_decisions"
  TO stella_public_law_reader;
