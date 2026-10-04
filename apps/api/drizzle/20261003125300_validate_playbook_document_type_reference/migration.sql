-- requires: 20261003125200_playbook_document_type_reference
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Commit the prerequisite and its migration receipt before validation.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- Retry cleanup removes only this migration's index after an interrupted build.
DROP INDEX CONCURRENTLY IF EXISTS "playbook_definitions_org_document_type_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "playbook_definitions_org_document_type_idx"
  ON "playbook_definitions" ("organization_id", "document_type_key");
--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
-- A definition stored before the reference existed can name a document type
-- its organization has since deleted. Restore that type under its key (the
-- key doubles as its label) so the definition keeps its stated scope. The
-- reference already holds for every write since the previous migration, so
-- this covers every row validation checks.
-- stella-migration-safety: reviewed insert-select - inserts one row per deleted type a definition still names (normally none) under the statement timeout; the transaction rolls back with the validation on failure
INSERT INTO "document_types" ("id", "organization_id", "key", "label")
SELECT gen_random_uuid(), orphan."organization_id", orphan."document_type_key", orphan."document_type_key"
FROM (
  SELECT DISTINCT definition."organization_id", definition."document_type_key"
  FROM "playbook_definitions" definition
  WHERE definition."document_type_key" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "document_types" existing
      WHERE existing."organization_id" = definition."organization_id"
        AND existing."key" = definition."document_type_key"
    )
) orphan
ON CONFLICT ON CONSTRAINT "document_types_org_key_unq" DO NOTHING;
--> statement-breakpoint
ALTER TABLE "playbook_definitions" VALIDATE CONSTRAINT "playbook_definitions_document_type_fk";
