SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- XLSX attachments uploaded before this migration populate the nullable cache
-- on their next chat hydration. New uploads persist bounded extracted text
-- before their user_files row becomes visible.
ALTER TABLE "user_files"
  ADD COLUMN "extracted_text" text;
