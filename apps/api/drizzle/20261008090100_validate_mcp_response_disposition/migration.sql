-- requires: 20261008090000_chat_secrets
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "mcp_user_connections"
  VALIDATE CONSTRAINT "mcp_user_connections_response_disposition_check";--> statement-breakpoint
ALTER TABLE "mcp_user_connections"
  VALIDATE CONSTRAINT "mcp_user_connections_response_target_check";
