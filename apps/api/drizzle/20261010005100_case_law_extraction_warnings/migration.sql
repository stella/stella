-- requires: 20261010005000_disable_legacy_desktop_credentials
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- A constant default avoids a document backfill. This column inherits the
-- decisions table's forced RLS and public corpus read policies.
ALTER TABLE "case_law_decisions" ADD COLUMN "extraction_warnings" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint

-- The constrained public reader serves diagnostics alongside decision metadata.
GRANT SELECT ("extraction_warnings") ON TABLE "case_law_decisions" TO stella_public_law_reader;
