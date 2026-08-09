import Elysia from "elysia";

import { RESOURCE_TYPE } from "@stll/api-contract";

import { env } from "@/api/env";
import acknowledgeWorkObligation from "@/api/handlers/work-obligations/acknowledgements/create";
import transitionWorkObligation from "@/api/handlers/work-obligations/transition";
import updateWorkObligation from "@/api/handlers/work-obligations/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import {
  resourceRealtime,
  workspaceResourceSetUpdates,
} from "@/api/lib/resource-realtime-macro";

const workObligationRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.ENTITY,
);

export const workObligationsRoute = new Elysia({
  prefix: "/work-obligations/:workspaceId",
})
  .use(deploymentFeatureGate(env.isDev || env.FEATURE_GOVERNED_WORKFLOW))
  .use(workspaceAccessMacro)
  .use(resourceRealtime)
  .use(permissionMacro)
  .guard({ validateWorkspaceAccess: true })
  .patch("/:entityId", updateWorkObligation.handler, {
    params: updateWorkObligation.config.params,
    body: updateWorkObligation.config.body,
    resourceSetUpdated: workObligationRealtimeUpdates,
    permissions: updateWorkObligation.config.permissions,
  })
  .post("/:entityId/acknowledge", acknowledgeWorkObligation.handler, {
    params: acknowledgeWorkObligation.config.params,
    resourceSetUpdated: workObligationRealtimeUpdates,
    permissions: acknowledgeWorkObligation.config.permissions,
  })
  .post("/:entityId/transition", transitionWorkObligation.handler, {
    params: transitionWorkObligation.config.params,
    body: transitionWorkObligation.config.body,
    resourceSetUpdated: workObligationRealtimeUpdates,
    permissions: transitionWorkObligation.config.permissions,
  });
