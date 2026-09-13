SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A reader's highlights and comments now sit on statutes as well as on
-- decisions, so the table names the document it marks with a discriminator
-- instead of naming one corpus. Every existing row is a decision note; the
-- rename keeps them, their group ties, their policies and their grants.
-- stella-migration-safety: reviewed rename-table-or-column - the only readers of the table are the handlers renamed in this release, and the web app is deployed with the API
ALTER TABLE "case_law_decision_annotations"
  RENAME TO "legal_reader_annotations";--> statement-breakpoint

-- stella-migration-safety: reviewed rename-table-or-column - the column is read only by the handlers renamed in this release
ALTER TABLE "legal_reader_annotations"
  RENAME COLUMN "decision_id" TO "target_id";--> statement-breakpoint

-- Constraint and index names follow the table, so the schema Drizzle declares
-- and the schema on disk stay one object under one name.
-- stella-migration-safety: reviewed rename-table-or-column - renames a constraint identifier only; no column, row or privilege changes
ALTER TABLE "legal_reader_annotations"
  RENAME CONSTRAINT "case_law_decision_annotations_pkey"
  TO "legal_reader_annotations_pkey";--> statement-breakpoint

-- stella-migration-safety: reviewed rename-table-or-column - renames a constraint identifier only
ALTER TABLE "legal_reader_annotations"
  RENAME CONSTRAINT "case_law_decision_annotations_organization_id_fk"
  TO "legal_reader_annotations_organization_id_fk";--> statement-breakpoint

-- stella-migration-safety: reviewed rename-table-or-column - renames a constraint identifier only
ALTER TABLE "legal_reader_annotations"
  RENAME CONSTRAINT "case_law_decision_annotations_user_id_fk"
  TO "legal_reader_annotations_user_id_fk";--> statement-breakpoint

-- stella-migration-safety: reviewed rename-table-or-column - renames a constraint identifier only
ALTER TABLE "legal_reader_annotations"
  RENAME CONSTRAINT "case_law_decision_annotations_kind_shape"
  TO "legal_reader_annotations_kind_shape";--> statement-breakpoint

-- stella-migration-safety: reviewed rename-table-or-column - renames a constraint identifier only
ALTER TABLE "legal_reader_annotations"
  RENAME CONSTRAINT "case_law_decision_annotations_span_shape"
  TO "legal_reader_annotations_span_shape";--> statement-breakpoint

-- The value constraints are re-stated rather than renamed: a migration is
-- what the database enforces, and `schema-invariants.test.ts` reads each
-- enumerated CHECK out of the migration that spells its values.
-- stella-migration-safety: reviewed drop-constraint - each constraint is re-added under its new name in the statement below with the same value list
ALTER TABLE "legal_reader_annotations"
  DROP CONSTRAINT "case_law_decision_annotations_kind_values";--> statement-breakpoint

ALTER TABLE "legal_reader_annotations"
  ADD CONSTRAINT "legal_reader_annotations_kind_values"
  CHECK ("kind" IN ('highlight', 'comment')) NOT VALID;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - re-added under its new name below with the same value list
ALTER TABLE "legal_reader_annotations"
  DROP CONSTRAINT "case_law_decision_annotations_visibility_values";--> statement-breakpoint

ALTER TABLE "legal_reader_annotations"
  ADD CONSTRAINT "legal_reader_annotations_visibility_values"
  CHECK ("visibility" IN ('private', 'shared')) NOT VALID;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - re-added under its new name below with the same value list
ALTER TABLE "legal_reader_annotations"
  DROP CONSTRAINT "case_law_decision_annotations_color_values";--> statement-breakpoint

ALTER TABLE "legal_reader_annotations"
  ADD CONSTRAINT "legal_reader_annotations_color_values"
  CHECK ("color" IS NULL OR "color" IN ('yellow', 'green', 'sky', 'violet', 'red')) NOT VALID;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - re-added under its new name below with the same value list
ALTER TABLE "legal_reader_annotations"
  DROP CONSTRAINT "case_law_decision_annotations_style_values";--> statement-breakpoint

ALTER TABLE "legal_reader_annotations"
  ADD CONSTRAINT "legal_reader_annotations_style_values"
  CHECK ("style" IS NULL OR "style" IN ('highlight', 'underline', 'squiggly', 'strikethrough')) NOT VALID;--> statement-breakpoint

-- Which corpus the target id names. The default backfills the existing rows
-- without a table rewrite (Postgres stores it in the catalogue), and is then
-- dropped so a new row has to say what it marks.
ALTER TABLE "legal_reader_annotations"
  ADD COLUMN "target_type" text DEFAULT 'decision' NOT NULL;--> statement-breakpoint

ALTER TABLE "legal_reader_annotations"
  ALTER COLUMN "target_type" DROP DEFAULT;--> statement-breakpoint

ALTER TABLE "legal_reader_annotations"
  ADD CONSTRAINT "legal_reader_annotations_target_type_values"
  CHECK ("target_type" IN ('decision', 'statute')) NOT VALID;--> statement-breakpoint

-- The listing reads one document's notes, and a target id is a UUID, so the
-- index leads with the tenant and the id; the discriminator narrows nothing a
-- UUID has not already narrowed.
ALTER INDEX "case_law_decision_annotations_decision_idx"
  RENAME TO "legal_reader_annotations_target_idx";--> statement-breakpoint

ALTER INDEX "case_law_decision_annotations_group_idx"
  RENAME TO "legal_reader_annotations_group_idx";
