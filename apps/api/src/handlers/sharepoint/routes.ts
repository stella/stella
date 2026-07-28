import Elysia from "elysia";

import connectSharepoint from "@/api/handlers/sharepoint/connect";
import disconnectSharepoint from "@/api/handlers/sharepoint/disconnect";
import listSharepointDriveRoot from "@/api/handlers/sharepoint/list-drive-root";
import sharepointOAuthCallback from "@/api/handlers/sharepoint/oauth-callback";
import sharepointConnectionStatus from "@/api/handlers/sharepoint/status";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const sharepointRoute = new Elysia({ prefix: "/sharepoint" })
  .use(authMacro)
  .use(permissionMacro)
  .use(invalidateQuery)
  .guard({ validateAuth: true })
  .get("/oauth/callback", sharepointOAuthCallback.handler, {
    permissions: sharepointOAuthCallback.config.permissions,
    query: sharepointOAuthCallback.config.query,
  })
  .post("/connect", connectSharepoint.handler, {
    invalidateQuery: true,
    permissions: connectSharepoint.config.permissions,
  })
  .get("/connection", sharepointConnectionStatus.handler, {
    permissions: sharepointConnectionStatus.config.permissions,
  })
  .delete("/connection", disconnectSharepoint.handler, {
    invalidateQuery: true,
    permissions: disconnectSharepoint.config.permissions,
  })
  .get("/drive/root", listSharepointDriveRoot.handler, {
    permissions: listSharepointDriveRoot.config.permissions,
    query: listSharepointDriveRoot.config.query,
  });
