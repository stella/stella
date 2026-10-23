import Elysia from "elysia";

import connectMicrosoft365 from "@/api/handlers/microsoft365/connect";
import disconnectMicrosoft365 from "@/api/handlers/microsoft365/disconnect";
import listMicrosoft365DriveRoot from "@/api/handlers/microsoft365/list-drive-root";
import microsoft365OAuthCallback from "@/api/handlers/microsoft365/oauth-callback";
import setMicrosoft365Enablement from "@/api/handlers/microsoft365/set-enablement";
import microsoft365ConnectionStatus from "@/api/handlers/microsoft365/status";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const microsoft365Route = new Elysia({ prefix: "/microsoft365" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/oauth/callback", microsoft365OAuthCallback.handler, {
    permissions: microsoft365OAuthCallback.config.permissions,
    accountAccess: microsoft365OAuthCallback.config.accountAccess,
    query: microsoft365OAuthCallback.config.query,
  })
  .put("/enablement", setMicrosoft365Enablement.handler, {
    body: setMicrosoft365Enablement.config.body,
    permissions: setMicrosoft365Enablement.config.permissions,
    accountAccess: setMicrosoft365Enablement.config.accountAccess,
  })
  .post("/connect", connectMicrosoft365.handler, {
    body: connectMicrosoft365.config.body,
    permissions: connectMicrosoft365.config.permissions,
    accountAccess: connectMicrosoft365.config.accountAccess,
  })
  .get("/connection", microsoft365ConnectionStatus.handler, {
    permissions: microsoft365ConnectionStatus.config.permissions,
    accountAccess: microsoft365ConnectionStatus.config.accountAccess,
  })
  .delete("/connection", disconnectMicrosoft365.handler, {
    permissions: disconnectMicrosoft365.config.permissions,
    accountAccess: disconnectMicrosoft365.config.accountAccess,
  })
  .get("/drive/root", listMicrosoft365DriveRoot.handler, {
    permissions: listMicrosoft365DriveRoot.config.permissions,
    accountAccess: listMicrosoft365DriveRoot.config.accountAccess,
    query: listMicrosoft365DriveRoot.config.query,
  });
