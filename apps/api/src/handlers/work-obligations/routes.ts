import Elysia from "elysia";

import acknowledgeWorkObligation from "@/api/handlers/work-obligations/acknowledgements/create";
import transitionWorkObligation from "@/api/handlers/work-obligations/transition";
import updateWorkObligation from "@/api/handlers/work-obligations/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const workObligationsRoute = new Elysia({
  prefix: "/work-obligations/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .use(permissionMacro)
  .guard({ validateWorkspaceAccess: true })
  .patch("/:entityId", updateWorkObligation.handler, {
    params: updateWorkObligation.config.params,
    body: updateWorkObligation.config.body,
    invalidateQuery: true,
    permissions: updateWorkObligation.config.permissions,
  })
  .post("/:entityId/acknowledge", acknowledgeWorkObligation.handler, {
    params: acknowledgeWorkObligation.config.params,
    invalidateQuery: true,
    permissions: acknowledgeWorkObligation.config.permissions,
  })
  .post("/:entityId/transition", transitionWorkObligation.handler, {
    params: transitionWorkObligation.config.params,
    body: transitionWorkObligation.config.body,
    invalidateQuery: true,
    permissions: transitionWorkObligation.config.permissions,
  });
