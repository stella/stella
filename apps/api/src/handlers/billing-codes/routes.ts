import Elysia from "elysia";

import createBillingCode from "@/api/handlers/billing-codes/create";
import deleteBillingCode from "@/api/handlers/billing-codes/delete";
import readBillingCodes from "@/api/handlers/billing-codes/list";
import updateBillingCode from "@/api/handlers/billing-codes/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
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
  .use(featureAccessGate("time-billing"))
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get(
    "/",
    {
      permissions: readBillingCodes.config.permissions,
      query: readBillingCodes.config.query,
    },
    readBillingCodes.handler,
  )
  .put(
    "/",
    {
      body: createBillingCode.config.body,
      permissions: createBillingCode.config.permissions,
    },
    createBillingCode.handler,
  )
  .patch(
    "/",
    {
      body: updateBillingCode.config.body,
      permissions: updateBillingCode.config.permissions,
    },
    updateBillingCode.handler,
  )
  .delete(
    "/",
    {
      body: deleteBillingCode.config.body,
      permissions: deleteBillingCode.config.permissions,
    },
    deleteBillingCode.handler,
  );
