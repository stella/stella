import Elysia from "elysia";

import confirmOutboundAction from "@/api/handlers/outbound-actions/confirm";
import discardOutboundAction from "@/api/handlers/outbound-actions/discard";
import readOutboundAction from "@/api/handlers/outbound-actions/read";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const outboundActionsRoute = new Elysia({ prefix: "/outbound-actions" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/:actionId", readOutboundAction.handler, {
    params: readOutboundAction.config.params,
    permissions: readOutboundAction.config.permissions,
  })
  .post("/:actionId/confirm", confirmOutboundAction.handler, {
    body: confirmOutboundAction.config.body,
    params: confirmOutboundAction.config.params,
    permissions: confirmOutboundAction.config.permissions,
  })
  .post("/:actionId/discard", discardOutboundAction.handler, {
    params: discardOutboundAction.config.params,
    permissions: discardOutboundAction.config.permissions,
  });
