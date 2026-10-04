import Elysia from "elysia";

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
import { authMacro, permissionMacro } from "@/api/lib/auth";

const authenticatedMcpConnectorsRoute = new Elysia({ prefix: "/mcp" })
  .use(authMacro)
  .use(permissionMacro)
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
    permissions: createMcpConnector.config.permissions,
  })
  .post("/connectors/probe", probeMcpConnector.handler, {
    body: probeMcpConnector.config.body,
    permissions: probeMcpConnector.config.permissions,
  })
  .post("/connectors/:slug/connect", connectMcpConnector.handler, {
    params: connectMcpConnector.config.params,
    permissions: connectMcpConnector.config.permissions,
  })
  .post(
    "/connectors/:slug/approve-authorization",
    approveMcpAuthorization.handler,
    {
      params: approveMcpAuthorization.config.params,
      body: approveMcpAuthorization.config.body,
      permissions: approveMcpAuthorization.config.permissions,
    },
  )
  .delete("/connectors/:slug", deleteMcpConnector.handler, {
    params: deleteMcpConnector.config.params,
    permissions: deleteMcpConnector.config.permissions,
  })
  .get("/connections", listMcpConnections.handler, {
    permissions: listMcpConnections.config.permissions,
  })
  .post("/connections", createMcpConnection.handler, {
    body: createMcpConnection.config.body,
    permissions: createMcpConnection.config.permissions,
  })
  .patch("/connections/:connectionId", updateMcpConnection.handler, {
    body: updateMcpConnection.config.body,
    params: updateMcpConnection.config.params,
    permissions: updateMcpConnection.config.permissions,
  })
  .delete("/connections/:connectionId", deleteMcpConnection.handler, {
    params: deleteMcpConnection.config.params,
    permissions: deleteMcpConnection.config.permissions,
  })
  .patch("/native-tools/:slug", updateNativeTool.handler, {
    body: updateNativeTool.config.body,
    params: updateNativeTool.config.params,
    permissions: updateNativeTool.config.permissions,
  });

export const mcpConnectorsRoute = new Elysia()
  .use(mcpOAuthClientMetadataRoute)
  .use(authenticatedMcpConnectorsRoute);
