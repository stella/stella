SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Existing rows came from Folio's inline-only table representation. Null
-- therefore remains a compatible inline discriminator during rolling deploys;
-- current writers persist every table row's explicit layout.
ALTER TABLE "bilingual_translation_rows"
  ADD COLUMN IF NOT EXISTS "table_layout" text;
--> statement-breakpoint
ALTER TABLE "bilingual_translation_rows"
  ADD CONSTRAINT "bilingual_translation_rows_table_layout_values_check"
  CHECK ("table_layout" IS NULL OR "table_layout" IN ('inline', 'stacked')) NOT VALID;
