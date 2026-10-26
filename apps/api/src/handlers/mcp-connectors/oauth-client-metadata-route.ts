import cliMetadataHandler from "@/api/handlers/mcp-connectors/read-cli-client-metadata";
import metadataHandler from "@/api/handlers/mcp-connectors/read-client-metadata";
import { routes } from "@/api/http/route";

// OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-
// document): external MCP authorization servers fetch the first URL to resolve
// stella's client metadata, and the second identifies the stella CLI, so the
// routes must stay public (no caller authentication).
export const mcpOAuthClientMetadataRoute = routes(
  {
    "/oauth/client-metadata.json": { GET: metadataHandler },
    "/oauth/cli-client-metadata.json": { GET: cliMetadataHandler },
  },
  { prefix: "/mcp" },
);
