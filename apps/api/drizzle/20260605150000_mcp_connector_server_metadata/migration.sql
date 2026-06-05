ALTER TABLE "mcp_connectors"
  ADD COLUMN "server_version" text;

ALTER TABLE "mcp_connectors"
  ADD COLUMN "instructions" text;

ALTER TABLE "mcp_connectors"
  ADD COLUMN "oauth_issuer" text;
