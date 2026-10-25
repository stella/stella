-- requires: 20261020013635_case_law_source_hash_version
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- A constant default avoids a document backfill. This column inherits the
-- decisions table's forced RLS and public corpus read policies.
ALTER TABLE "case_law_decisions"
  ADD COLUMN "extraction_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

-- The decision views expand SELECT * when defined, so they are redefined to
-- carry the new column with their filters unchanged.
CREATE OR REPLACE VIEW "case_law_published_decisions" AS
SELECT *
FROM "case_law_decisions"
WHERE (redacted_at IS NULL AND jsonb_extract_path_text(metadata, '_stellaPartialObservation', 'isListingOnly') is distinct from 'true');--> statement-breakpoint

CREATE OR REPLACE VIEW "case_law_unredacted_decisions" AS
SELECT *
FROM "case_law_decisions"
WHERE redacted_at IS NULL;--> statement-breakpoint

-- The constrained public reader serves diagnostics alongside decision metadata.
GRANT SELECT ("extraction_warnings") ON TABLE "case_law_published_decisions", "case_law_unredacted_decisions" TO "stella_public_law_reader";
