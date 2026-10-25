import cliMetadataHandler from "@/api/handlers/mcp-connectors/read-cli-client-metadata";
import metadataHandler from "@/api/handlers/mcp-connectors/read-client-metadata";
import mobileMetadataHandler from "@/api/handlers/mcp-connectors/read-mobile-client-metadata";
import { routes } from "@/api/http/route";

// OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-
// document): external MCP authorization servers fetch the first URL to resolve
// stella's client metadata, and the others identify the stella CLI and the
// stella mobile app, so the routes must stay public (no auth macro).
export const mcpOAuthClientMetadataRoute = routes(
  {
    "/oauth/client-metadata.json": { GET: metadataHandler },
    "/oauth/cli-client-metadata.json": { GET: cliMetadataHandler },
    "/oauth/mobile-client-metadata.json": { GET: mobileMetadataHandler },
  },
  { prefix: "/mcp" },
);
