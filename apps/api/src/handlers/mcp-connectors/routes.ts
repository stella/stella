import Elysia from "elysia";

import connectMcpConnector from "@/api/handlers/mcp-connectors/connect";
import createMcpConnection from "@/api/handlers/mcp-connectors/create-connection";
import createMcpConnector from "@/api/handlers/mcp-connectors/create-connector";
import deleteMcpConnection from "@/api/handlers/mcp-connectors/delete-connection";
import deleteMcpConnector from "@/api/handlers/mcp-connectors/delete-connector";
import listMcpConnections from "@/api/handlers/mcp-connectors/list-connections";
import listMcpConnectors from "@/api/handlers/mcp-connectors/list-connectors";
import mcpOAuthCallback from "@/api/handlers/mcp-connectors/oauth-callback";
import probeMcpConnector from "@/api/handlers/mcp-connectors/probe-connector";
import updateMcpConnection from "@/api/handlers/mcp-connectors/update-connection";
import updateNativeTool from "@/api/handlers/mcp-connectors/update-native-tool";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

const authenticatedMcpConnectorsRoute = new Elysia({ prefix: "/mcp" })
  .use(authMacro)
  .use(permissionMacro)
  .use(invalidateQuery)
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
    invalidateQuery: true,
    permissions: createMcpConnector.config.permissions,
  })
  .post("/connectors/probe", probeMcpConnector.handler, {
    body: probeMcpConnector.config.body,
    permissions: probeMcpConnector.config.permissions,
  })
  .post("/connectors/:slug/connect", connectMcpConnector.handler, {
    invalidateQuery: true,
    params: connectMcpConnector.config.params,
    permissions: connectMcpConnector.config.permissions,
  })
  .delete("/connectors/:slug", deleteMcpConnector.handler, {
    invalidateQuery: true,
    params: deleteMcpConnector.config.params,
    permissions: deleteMcpConnector.config.permissions,
  })
  .get("/connections", listMcpConnections.handler, {
    permissions: listMcpConnections.config.permissions,
  })
  .post("/connections", createMcpConnection.handler, {
    body: createMcpConnection.config.body,
    invalidateQuery: true,
    permissions: createMcpConnection.config.permissions,
  })
  .patch("/connections/:connectionId", updateMcpConnection.handler, {
    body: updateMcpConnection.config.body,
    invalidateQuery: true,
    params: updateMcpConnection.config.params,
    permissions: updateMcpConnection.config.permissions,
  })
  .delete("/connections/:connectionId", deleteMcpConnection.handler, {
    invalidateQuery: true,
    params: deleteMcpConnection.config.params,
    permissions: deleteMcpConnection.config.permissions,
  })
  .patch("/native-tools/:slug", updateNativeTool.handler, {
    body: updateNativeTool.config.body,
    invalidateQuery: true,
    params: updateNativeTool.config.params,
    permissions: updateNativeTool.config.permissions,
  });

export const mcpConnectorsRoute = new Elysia().use(
  authenticatedMcpConnectorsRoute,
);
