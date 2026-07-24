SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- The referenced composite unique index is built concurrently in the prior
-- migration. Attach it as a constraint so the migrated database remains
-- structurally identical to schema.ts without rebuilding the index under lock.
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_id_org_unq" UNIQUE USING INDEX "workspaces_id_org_unq";
--> statement-breakpoint
-- NOT VALID avoids scanning under an ACCESS EXCLUSIVE lock while
-- still enforcing tenant ownership for every new memory write immediately.
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_workspace_org_fkey" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces"("id", "organization_id") ON DELETE CASCADE NOT VALID;
