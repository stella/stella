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
    query: mcpOAuthCallback.config.query,
  })
  .get("/connectors", listMcpConnectors.handler)
  .post("/connectors", createMcpConnector.handler, {
    body: createMcpConnector.config.body,
    invalidateQuery: true,
  })
  .post("/connectors/probe", probeMcpConnector.handler, {
    body: probeMcpConnector.config.body,
  })
  .post("/connectors/:slug/connect", connectMcpConnector.handler, {
    params: connectMcpConnector.config.params,
    invalidateQuery: true,
  })
  .delete("/connectors/:slug", deleteMcpConnector.handler, {
    params: deleteMcpConnector.config.params,
    invalidateQuery: true,
  })
  .get("/connections", listMcpConnections.handler)
  .post("/connections", createMcpConnection.handler, {
    body: createMcpConnection.config.body,
    invalidateQuery: true,
  })
  .patch("/connections/:connectionId", updateMcpConnection.handler, {
    params: updateMcpConnection.config.params,
    body: updateMcpConnection.config.body,
    invalidateQuery: true,
  })
  .delete("/connections/:connectionId", deleteMcpConnection.handler, {
    params: deleteMcpConnection.config.params,
    invalidateQuery: true,
  })
  .patch("/native-tools/:slug", updateNativeTool.handler, {
    params: updateNativeTool.config.params,
    body: updateNativeTool.config.body,
    invalidateQuery: true,
  });

export const mcpConnectorsRoute = new Elysia().use(
  authenticatedMcpConnectorsRoute,
);
