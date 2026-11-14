SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A selection over several paragraphs keeps its first span in the existing
-- columns and the rest here. The constant default is metadata-only, so
-- existing single-paragraph answers need no rewrite or backfill.
ALTER TABLE "legal_reader_answers"
  ADD COLUMN IF NOT EXISTS "continuation_spans" jsonb DEFAULT '[]'::jsonb NOT NULL;
