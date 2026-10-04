import Elysia from "elysia";

import acknowledgeWorkObligation from "@/api/handlers/work-obligations/acknowledgements/create";
import transitionWorkObligation from "@/api/handlers/work-obligations/transition";
import updateWorkObligation from "@/api/handlers/work-obligations/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const workObligationsRoute = new Elysia({
  prefix: "/work-obligations/:workspaceId",
})
  .use(
    deploymentFeatureGate(() =>
      isDeploymentFeatureEnabled("FEATURE_GOVERNED_WORKFLOW"),
    ),
  )
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({ validateWorkspaceAccess: true })
  .patch("/:entityId", updateWorkObligation.handler, {
    params: updateWorkObligation.config.params,
    body: updateWorkObligation.config.body,
    permissions: updateWorkObligation.config.permissions,
  })
  .post("/:entityId/acknowledge", acknowledgeWorkObligation.handler, {
    params: acknowledgeWorkObligation.config.params,
    permissions: acknowledgeWorkObligation.config.permissions,
  })
  .post("/:entityId/transition", transitionWorkObligation.handler, {
    params: transitionWorkObligation.config.params,
    body: transitionWorkObligation.config.body,
    permissions: transitionWorkObligation.config.permissions,
  });
