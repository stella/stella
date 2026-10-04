import Elysia from "elysia";

import createBillingCode from "@/api/handlers/billing-codes/create";
import deleteBillingCode from "@/api/handlers/billing-codes/delete";
import readBillingCodes from "@/api/handlers/billing-codes/list";
import updateBillingCode from "@/api/handlers/billing-codes/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const billingCodesRoute = new Elysia({
  prefix: "/billing-codes/:workspaceId",
})
  .use(
    deploymentFeatureGate(() =>
      isDeploymentFeatureEnabled("FEATURE_TIME_BILLING"),
    ),
  )
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get("/", readBillingCodes.handler, {
    permissions: readBillingCodes.config.permissions,
    query: readBillingCodes.config.query,
  })
  .put("/", createBillingCode.handler, {
    body: createBillingCode.config.body,
    permissions: createBillingCode.config.permissions,
  })
  .patch("/", updateBillingCode.handler, {
    body: updateBillingCode.config.body,
    permissions: updateBillingCode.config.permissions,
  })
  .delete("/", deleteBillingCode.handler, {
    body: deleteBillingCode.config.body,
    permissions: deleteBillingCode.config.permissions,
  });
