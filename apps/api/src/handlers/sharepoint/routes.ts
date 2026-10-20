import Elysia from "elysia";

import connectSharepoint from "@/api/handlers/sharepoint/connect";
import disconnectSharepoint from "@/api/handlers/sharepoint/disconnect";
import listSharepointDriveRoot from "@/api/handlers/sharepoint/list-drive-root";
import sharepointOAuthCallback from "@/api/handlers/sharepoint/oauth-callback";
import setSharepointEnablement from "@/api/handlers/sharepoint/set-enablement";
import sharepointConnectionStatus from "@/api/handlers/sharepoint/status";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const sharepointRoute = new Elysia({ prefix: "/sharepoint" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get(
    "/oauth/callback",
    {
      permissions: sharepointOAuthCallback.config.permissions,
      query: sharepointOAuthCallback.config.query,
    },
    sharepointOAuthCallback.handler,
  )
  .put(
    "/enablement",
    {
      body: setSharepointEnablement.config.body,
      permissions: setSharepointEnablement.config.permissions,
    },
    setSharepointEnablement.handler,
  )
  .post(
    "/connect",
    {
      permissions: connectSharepoint.config.permissions,
    },
    connectSharepoint.handler,
  )
  .get(
    "/connection",
    {
      permissions: sharepointConnectionStatus.config.permissions,
    },
    sharepointConnectionStatus.handler,
  )
  .delete(
    "/connection",
    {
      permissions: disconnectSharepoint.config.permissions,
    },
    disconnectSharepoint.handler,
  )
  .get(
    "/drive/root",
    {
      permissions: listSharepointDriveRoot.config.permissions,
      query: listSharepointDriveRoot.config.query,
    },
    listSharepointDriveRoot.handler,
  );
