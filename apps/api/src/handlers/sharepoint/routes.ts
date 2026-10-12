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
  .get("/oauth/callback", sharepointOAuthCallback.handler, {
    permissions: sharepointOAuthCallback.config.permissions,
    accountAccess: sharepointOAuthCallback.config.accountAccess,
    query: sharepointOAuthCallback.config.query,
  })
  .put("/enablement", setSharepointEnablement.handler, {
    body: setSharepointEnablement.config.body,
    permissions: setSharepointEnablement.config.permissions,
    accountAccess: setSharepointEnablement.config.accountAccess,
  })
  .post("/connect", connectSharepoint.handler, {
    permissions: connectSharepoint.config.permissions,
    accountAccess: connectSharepoint.config.accountAccess,
  })
  .get("/connection", sharepointConnectionStatus.handler, {
    permissions: sharepointConnectionStatus.config.permissions,
    accountAccess: sharepointConnectionStatus.config.accountAccess,
  })
  .delete("/connection", disconnectSharepoint.handler, {
    permissions: disconnectSharepoint.config.permissions,
    accountAccess: disconnectSharepoint.config.accountAccess,
  })
  .get("/drive/root", listSharepointDriveRoot.handler, {
    permissions: listSharepointDriveRoot.config.permissions,
    accountAccess: listSharepointDriveRoot.config.accountAccess,
    query: listSharepointDriveRoot.config.query,
  });
