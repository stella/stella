import Elysia from "elysia";

import cliMetadataHandler from "@/api/handlers/mcp-connectors/read-cli-client-metadata";
import metadataHandler from "@/api/handlers/mcp-connectors/read-client-metadata";

// OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-
// document): external MCP authorization servers fetch the first URL to resolve
// stella's client metadata, and the second identifies the stella CLI, so the
// routes must stay public (no auth macro).
export const mcpOAuthClientMetadataRoute = new Elysia({ prefix: "/mcp" })
  .get(
    "/oauth/client-metadata.json",
    {
      response: metadataHandler.config.response,
    },
    metadataHandler.handler,
  )
  .get(
    "/oauth/cli-client-metadata.json",
    {
      response: cliMetadataHandler.config.response,
    },
    cliMetadataHandler.handler,
  );
