ALTER TABLE "mcp_user_connections" ADD COLUMN "cached_tools" jsonb;
--> statement-breakpoint
ALTER TABLE "mcp_user_connections" ADD COLUMN "cached_tools_refreshed_at" timestamp;
