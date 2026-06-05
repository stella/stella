ALTER TABLE "mcp_connectors"
  ADD COLUMN "oauth_issuer" text;

ALTER TABLE "mcp_user_connections"
  ADD COLUMN "server_version" text;

ALTER TABLE "mcp_user_connections"
  ADD COLUMN "instructions" text;
