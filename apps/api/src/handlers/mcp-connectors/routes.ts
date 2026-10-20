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
  .get(
    "/oauth/callback",
    {
      permissions: mcpOAuthCallback.config.permissions,
      query: mcpOAuthCallback.config.query,
    },
    mcpOAuthCallback.handler,
  )
  .get(
    "/connectors",
    {
      permissions: listMcpConnectors.config.permissions,
    },
    listMcpConnectors.handler,
  )
  .post(
    "/connectors",
    {
      body: createMcpConnector.config.body,
      permissions: createMcpConnector.config.permissions,
    },
    createMcpConnector.handler,
  )
  .post(
    "/connectors/probe",
    {
      body: probeMcpConnector.config.body,
      permissions: probeMcpConnector.config.permissions,
    },
    probeMcpConnector.handler,
  )
  .post(
    "/connectors/:slug/connect",
    {
      params: connectMcpConnector.config.params,
      permissions: connectMcpConnector.config.permissions,
    },
    connectMcpConnector.handler,
  )
  .post(
    "/connectors/:slug/approve-authorization",
    {
      params: approveMcpAuthorization.config.params,
      body: approveMcpAuthorization.config.body,
      permissions: approveMcpAuthorization.config.permissions,
    },
    approveMcpAuthorization.handler,
  )
  .delete(
    "/connectors/:slug",
    {
      params: deleteMcpConnector.config.params,
      permissions: deleteMcpConnector.config.permissions,
    },
    deleteMcpConnector.handler,
  )
  .get(
    "/connections",
    {
      permissions: listMcpConnections.config.permissions,
    },
    listMcpConnections.handler,
  )
  .post(
    "/connections",
    {
      body: createMcpConnection.config.body,
      permissions: createMcpConnection.config.permissions,
    },
    createMcpConnection.handler,
  )
  .patch(
    "/connections/:connectionId",
    {
      body: updateMcpConnection.config.body,
      params: updateMcpConnection.config.params,
      permissions: updateMcpConnection.config.permissions,
    },
    updateMcpConnection.handler,
  )
  .delete(
    "/connections/:connectionId",
    {
      params: deleteMcpConnection.config.params,
      permissions: deleteMcpConnection.config.permissions,
    },
    deleteMcpConnection.handler,
  )
  .patch(
    "/native-tools/:slug",
    {
      body: updateNativeTool.config.body,
      params: updateNativeTool.config.params,
      permissions: updateNativeTool.config.permissions,
    },
    updateNativeTool.handler,
  );

export const mcpConnectorsRoute = new Elysia()
  .use(mcpOAuthClientMetadataRoute)
  .use(authenticatedMcpConnectorsRoute);
