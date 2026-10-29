SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The text either side of a mark's quote, so a mark is found again after a
-- re-parse moves its block anchor or offsets. Existing marks keep an empty
-- context, which agrees with any surroundings; the constant default is
-- metadata-only.
ALTER TABLE "legal_reader_annotations"
  ADD COLUMN IF NOT EXISTS "quote_prefix" varchar(32) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "quote_suffix" varchar(32) DEFAULT '' NOT NULL;
