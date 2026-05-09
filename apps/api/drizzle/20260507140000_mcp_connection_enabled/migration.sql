ALTER TABLE "mcp_user_connections" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE INDEX "mcp_user_connections_org_user_enabled_status_idx" ON "mcp_user_connections" ("organization_id","user_id","enabled","status");
