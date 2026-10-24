import Elysia from "elysia";

import cliMetadataHandler from "@/api/handlers/mcp-connectors/read-cli-client-metadata";
import metadataHandler from "@/api/handlers/mcp-connectors/read-client-metadata";
import mobileMetadataHandler from "@/api/handlers/mcp-connectors/read-mobile-client-metadata";

// OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-
// document): external MCP authorization servers fetch the first URL to resolve
// stella's client metadata, and the others identify the stella CLI and the
// stella mobile app, so the routes must stay public (no auth macro).
export const mcpOAuthClientMetadataRoute = new Elysia({ prefix: "/mcp" })
  .get("/oauth/client-metadata.json", metadataHandler.handler, {
    response: metadataHandler.config.response,
  })
  .get("/oauth/cli-client-metadata.json", cliMetadataHandler.handler, {
    response: cliMetadataHandler.config.response,
  })
  .get("/oauth/mobile-client-metadata.json", mobileMetadataHandler.handler, {
    response: mobileMetadataHandler.config.response,
  });
