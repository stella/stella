SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "playbook_definition_id" uuid;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_playbook_definition_id_playbook_definitions_id_fk" FOREIGN KEY ("playbook_definition_id") REFERENCES "playbook_definitions"("id") ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - retry cleanup drops only this migration's index before rebuilding it, so an interrupted INVALID index cannot be mistaken for completion.
DROP INDEX CONCURRENTLY IF EXISTS "properties_workspace_playbook_definition_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- preceding DROP removes invalid retry artifacts; IF NOT EXISTS could accept one.
CREATE INDEX CONCURRENTLY "properties_workspace_playbook_definition_idx" ON "properties" USING btree ("workspace_id","playbook_definition_id");
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
SET statement_timeout = '5s';
