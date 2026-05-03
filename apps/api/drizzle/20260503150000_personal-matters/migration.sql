-- stella-migration-safety: reviewed destructive-change - DROP INDEX is immediately followed by CREATE INDEX with the same name and same (organization_id, client_id) leading columns, plus a partial predicate that only excludes rows the index never needed to cover. Query plans are preserved.
-- Personal matters: workspaces no longer require a client.
--
-- A null client_id encodes a personal matter (visible only to the
-- creator via workspace_members). A non-null client_id is a normal
-- client matter. Personal -> client is a one-way promotion handled
-- by the update endpoint.

ALTER TABLE "workspaces" ALTER COLUMN "client_id" DROP NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "workspaces_org_client_id_idx";
--> statement-breakpoint
CREATE INDEX "workspaces_org_client_id_idx" ON "workspaces" ("organization_id", "client_id") WHERE "client_id" IS NOT NULL;
