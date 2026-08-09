import Elysia from "elysia";

import { RESOURCE_TYPE } from "@stll/api-contract";

import connectSharepoint from "@/api/handlers/sharepoint/connect";
import disconnectSharepoint from "@/api/handlers/sharepoint/disconnect";
import listSharepointDriveRoot from "@/api/handlers/sharepoint/list-drive-root";
import sharepointOAuthCallback from "@/api/handlers/sharepoint/oauth-callback";
import setSharepointEnablement from "@/api/handlers/sharepoint/set-enablement";
import sharepointConnectionStatus from "@/api/handlers/sharepoint/status";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import {
  organizationResourceSetUpdates,
  resourceRealtime,
} from "@/api/lib/resource-realtime-macro";

const sharepointRealtimeUpdates = organizationResourceSetUpdates(
  RESOURCE_TYPE.ORGANIZATION,
);

export const sharepointRoute = new Elysia({ prefix: "/sharepoint" })
  .use(authMacro)
  .use(permissionMacro)
  .use(resourceRealtime)
  .guard({ validateAuth: true })
  .get("/oauth/callback", sharepointOAuthCallback.handler, {
    permissions: sharepointOAuthCallback.config.permissions,
    query: sharepointOAuthCallback.config.query,
  })
  .put("/enablement", setSharepointEnablement.handler, {
    body: setSharepointEnablement.config.body,
    resourceSetUpdated: sharepointRealtimeUpdates,
    permissions: setSharepointEnablement.config.permissions,
  })
  .post("/connect", connectSharepoint.handler, {
    resourceSetUpdated: sharepointRealtimeUpdates,
    permissions: connectSharepoint.config.permissions,
  })
  .get("/connection", sharepointConnectionStatus.handler, {
    permissions: sharepointConnectionStatus.config.permissions,
  })
  .delete("/connection", disconnectSharepoint.handler, {
    resourceSetUpdated: sharepointRealtimeUpdates,
    permissions: disconnectSharepoint.config.permissions,
  })
  .get("/drive/root", listSharepointDriveRoot.handler, {
    permissions: listSharepointDriveRoot.config.permissions,
    query: listSharepointDriveRoot.config.query,
  });
