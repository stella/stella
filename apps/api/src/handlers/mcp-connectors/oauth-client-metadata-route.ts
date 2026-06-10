import Elysia from "elysia";

import { buildMcpClientMetadataDocument } from "@/api/handlers/mcp-connectors/oauth";

// OAuth Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-
// document): external MCP authorization servers fetch this URL to resolve
// stella's client metadata, so the route must stay public (no auth macro).
export const mcpOAuthClientMetadataRoute = new Elysia({ prefix: "/mcp" }).get(
  "/oauth/client-metadata.json",
  ({ set }) => {
    set.headers["cache-control"] = "public, max-age=3600";
    return buildMcpClientMetadataDocument();
  },
);
