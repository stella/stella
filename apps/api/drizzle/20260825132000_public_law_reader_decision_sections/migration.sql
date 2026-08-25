SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The public decision reader returns parsed sections alongside the AST. Keep
-- the constrained reader's column grant aligned with that public projection.
GRANT SELECT (sections)
  ON TABLE "case_law_decisions"
  TO stella_public_law_reader;
