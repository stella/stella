import Elysia from "elysia";

import { RESOURCE_TYPE } from "@stll/api-contract";

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
import { authMacro, permissionMacro } from "@/api/lib/auth";
import {
  organizationResourceSetUpdates,
  resourceRealtime,
} from "@/api/lib/resource-realtime-macro";

const mcpConnectorRealtimeUpdates = organizationResourceSetUpdates(
  RESOURCE_TYPE.MCP_CONNECTOR,
);

const authenticatedMcpConnectorsRoute = new Elysia({ prefix: "/mcp" })
  .use(authMacro)
  .use(permissionMacro)
  .use(resourceRealtime)
  .guard({ validateAuth: true })
  .get("/oauth/callback", mcpOAuthCallback.handler, {
    permissions: mcpOAuthCallback.config.permissions,
    query: mcpOAuthCallback.config.query,
  })
  .get("/connectors", listMcpConnectors.handler, {
    permissions: listMcpConnectors.config.permissions,
  })
  .post("/connectors", createMcpConnector.handler, {
    body: createMcpConnector.config.body,
    resourceSetUpdated: mcpConnectorRealtimeUpdates,
    permissions: createMcpConnector.config.permissions,
  })
  .post("/connectors/probe", probeMcpConnector.handler, {
    body: probeMcpConnector.config.body,
    permissions: probeMcpConnector.config.permissions,
  })
  .post("/connectors/:slug/connect", connectMcpConnector.handler, {
    resourceSetUpdated: mcpConnectorRealtimeUpdates,
    params: connectMcpConnector.config.params,
    permissions: connectMcpConnector.config.permissions,
  })
  .delete("/connectors/:slug", deleteMcpConnector.handler, {
    resourceSetUpdated: mcpConnectorRealtimeUpdates,
    params: deleteMcpConnector.config.params,
    permissions: deleteMcpConnector.config.permissions,
  })
  .get("/connections", listMcpConnections.handler, {
    permissions: listMcpConnections.config.permissions,
  })
  .post("/connections", createMcpConnection.handler, {
    body: createMcpConnection.config.body,
    resourceSetUpdated: mcpConnectorRealtimeUpdates,
    permissions: createMcpConnection.config.permissions,
  })
  .patch("/connections/:connectionId", updateMcpConnection.handler, {
    body: updateMcpConnection.config.body,
    resourceSetUpdated: mcpConnectorRealtimeUpdates,
    params: updateMcpConnection.config.params,
    permissions: updateMcpConnection.config.permissions,
  })
  .delete("/connections/:connectionId", deleteMcpConnection.handler, {
    resourceSetUpdated: mcpConnectorRealtimeUpdates,
    params: deleteMcpConnection.config.params,
    permissions: deleteMcpConnection.config.permissions,
  })
  .patch("/native-tools/:slug", updateNativeTool.handler, {
    body: updateNativeTool.config.body,
    resourceSetUpdated: mcpConnectorRealtimeUpdates,
    params: updateNativeTool.config.params,
    permissions: updateNativeTool.config.permissions,
  });

export const mcpConnectorsRoute = new Elysia()
  .use(mcpOAuthClientMetadataRoute)
  .use(authenticatedMcpConnectorsRoute);
