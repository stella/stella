-- requires: 20261003124600_playbook_document_type_reference
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
ALTER TABLE "playbook_definitions" VALIDATE CONSTRAINT "playbook_definitions_document_type_fk";
