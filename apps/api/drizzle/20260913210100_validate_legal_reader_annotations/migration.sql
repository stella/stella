SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The value constraints the rename re-stated were added NOT VALID, so the
-- rename itself took no validating scan. Validate them here, once the rename
-- is applied: every row already satisfied the identical constraints under
-- their previous names, and `target_type` carried a column default.
ALTER TABLE "legal_reader_annotations"
  VALIDATE CONSTRAINT "legal_reader_annotations_kind_values";--> statement-breakpoint

ALTER TABLE "legal_reader_annotations"
  VALIDATE CONSTRAINT "legal_reader_annotations_visibility_values";--> statement-breakpoint

ALTER TABLE "legal_reader_annotations"
  VALIDATE CONSTRAINT "legal_reader_annotations_color_values";--> statement-breakpoint

ALTER TABLE "legal_reader_annotations"
  VALIDATE CONSTRAINT "legal_reader_annotations_style_values";--> statement-breakpoint

ALTER TABLE "legal_reader_annotations"
  VALIDATE CONSTRAINT "legal_reader_annotations_target_type_values";
