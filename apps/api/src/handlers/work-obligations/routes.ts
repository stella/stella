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
  .patch(
    "/:entityId",
    {
      params: updateWorkObligation.config.params,
      body: updateWorkObligation.config.body,
      permissions: updateWorkObligation.config.permissions,
    },
    updateWorkObligation.handler,
  )
  .post(
    "/:entityId/acknowledge",
    {
      params: acknowledgeWorkObligation.config.params,
      permissions: acknowledgeWorkObligation.config.permissions,
    },
    acknowledgeWorkObligation.handler,
  )
  .post(
    "/:entityId/transition",
    {
      params: transitionWorkObligation.config.params,
      body: transitionWorkObligation.config.body,
      permissions: transitionWorkObligation.config.permissions,
    },
    transitionWorkObligation.handler,
  );
