SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
ALTER TABLE "mcp_oauth_state" ADD COLUMN "authorization_response_binding" jsonb;
