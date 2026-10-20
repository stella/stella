import Elysia from "elysia";

import createSavedTimeNarrative from "@/api/handlers/saved-time-narratives/create";
import deleteSavedTimeNarrative from "@/api/handlers/saved-time-narratives/delete";
import listSavedTimeNarratives from "@/api/handlers/saved-time-narratives/list";
import updateSavedTimeNarrative from "@/api/handlers/saved-time-narratives/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const savedTimeNarrativesRoute = new Elysia({
  prefix: "/saved-time-narratives",
})
  .use(
    deploymentFeatureGate(() =>
      isDeploymentFeatureEnabled("FEATURE_TIME_BILLING"),
    ),
  )
  .use(featureAccessGate("time-billing"))
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get(
    "/",
    {
      query: listSavedTimeNarratives.config.query,
      permissions: listSavedTimeNarratives.config.permissions,
    },
    listSavedTimeNarratives.handler,
  )
  .post(
    "/",
    {
      body: createSavedTimeNarrative.config.body,
      permissions: createSavedTimeNarrative.config.permissions,
    },
    createSavedTimeNarrative.handler,
  )
  .patch(
    "/:id",
    {
      params: updateSavedTimeNarrative.config.params,
      body: updateSavedTimeNarrative.config.body,
      permissions: updateSavedTimeNarrative.config.permissions,
    },
    updateSavedTimeNarrative.handler,
  )
  .delete(
    "/:id",
    {
      params: deleteSavedTimeNarrative.config.params,
      permissions: deleteSavedTimeNarrative.config.permissions,
    },
    deleteSavedTimeNarrative.handler,
  );
