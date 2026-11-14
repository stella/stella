import approveMcpAuthorization from "@/api/handlers/mcp-connectors/approve-authorization";
import connectMcpConnector from "@/api/handlers/mcp-connectors/connect";
import createMcpConnection from "@/api/handlers/mcp-connectors/create-connection";
import createMcpConnector from "@/api/handlers/mcp-connectors/create-connector";
import deleteMcpConnection from "@/api/handlers/mcp-connectors/delete-connection";
import deleteMcpConnector from "@/api/handlers/mcp-connectors/delete-connector";
import listMcpConnections from "@/api/handlers/mcp-connectors/list-connections";
import listMcpConnectors from "@/api/handlers/mcp-connectors/list-connectors";
import mcpOAuthCallback from "@/api/handlers/mcp-connectors/oauth-callback";
import { mcpOAuthClientMetadataRoute } from "@/api/handlers/mcp-connectors/oauth-client-metadata-route";
import probeMcpConnector from "@/api/handlers/mcp-connectors/probe-connector";
import updateMcpConnection from "@/api/handlers/mcp-connectors/update-connection";
import updateNativeTool from "@/api/handlers/mcp-connectors/update-native-tool";
import { mount, routes } from "@/api/http/route";

const authenticatedMcpConnectorsRoute = routes(
  {
    "/oauth/callback": { GET: mcpOAuthCallback },
    "/connectors": { GET: listMcpConnectors, POST: createMcpConnector },
    "/connectors/probe": { POST: probeMcpConnector },
    "/connectors/:slug/connect": { POST: connectMcpConnector },
    "/connectors/:slug/approve-authorization": {
      POST: approveMcpAuthorization,
    },
    "/connectors/:slug": { DELETE: deleteMcpConnector },
    "/connections": { GET: listMcpConnections, POST: createMcpConnection },
    "/connections/:connectionId": {
      PATCH: updateMcpConnection,
      DELETE: deleteMcpConnection,
    },
    "/native-tools/:slug": { PATCH: updateNativeTool },
  },
  { prefix: "/mcp" },
);

export const mcpConnectorsRoute = mount([
  mcpOAuthClientMetadataRoute,
  authenticatedMcpConnectorsRoute,
]);
