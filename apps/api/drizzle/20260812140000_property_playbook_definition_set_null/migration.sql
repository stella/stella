SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Deleting a playbook stops destroying the columns it materialized.
--
-- A materialized column holds one extracted answer and one graded verdict per
-- document in its workspace. Under ON DELETE CASCADE, deleting the org-level
-- definition erased that work in every matter the playbook had ever been run
-- against. The reference now nulls instead: the column is orphaned, keeps
-- working from the rules already copied into `tool`, and a later run of the
-- same playbook re-adopts it by `playbook_source_id`.
--
-- stella-migration-safety: reviewed destructive-change - drops only the FK
-- constraint so it can be re-added with ON DELETE SET NULL; the column, its
-- data, and its index are untouched, and the re-add below is in the same
-- transaction, so no window exists where the reference is unenforced.
ALTER TABLE "properties"
  DROP CONSTRAINT IF EXISTS "properties_playbook_definition_id_playbook_definitions_id_fk";--> statement-breakpoint

-- `properties` is an existing table with rows, so the constraint lands without
-- the up-front full scan. It enforces every new write from here; the scan that
-- proves the existing rows below runs outside this transaction so it never
-- holds a lock alongside anything else.
ALTER TABLE "properties"
  ADD CONSTRAINT "properties_playbook_definition_id_playbook_definitions_id_fk"
  FOREIGN KEY ("playbook_definition_id") REFERENCES "public"."playbook_definitions"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;--> statement-breakpoint

SET statement_timeout = 0;--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- Validating takes only SHARE UPDATE EXCLUSIVE, and on its own transaction it
-- blocks nothing else while it scans.
ALTER TABLE "properties"
  VALIDATE CONSTRAINT "properties_playbook_definition_id_playbook_definitions_id_fk";
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
SET statement_timeout = '5s';
