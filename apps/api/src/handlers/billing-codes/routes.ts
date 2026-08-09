import Elysia from "elysia";

import { RESOURCE_TYPE } from "@stll/api-contract";

import createBillingCode from "@/api/handlers/billing-codes/create";
import deleteBillingCode from "@/api/handlers/billing-codes/delete";
import readBillingCodes from "@/api/handlers/billing-codes/list";
import updateBillingCode from "@/api/handlers/billing-codes/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import {
  resourceRealtime,
  workspaceResourceSetUpdates,
} from "@/api/lib/resource-realtime-macro";

const billingCodeRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.BILLING_CODE,
);

export const billingCodesRoute = new Elysia({
  prefix: "/billing-codes/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(resourceRealtime)
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
    resourceSetUpdated: billingCodeRealtimeUpdates,
    permissions: createBillingCode.config.permissions,
  })
  .patch("/", updateBillingCode.handler, {
    body: updateBillingCode.config.body,
    resourceSetUpdated: billingCodeRealtimeUpdates,
    permissions: updateBillingCode.config.permissions,
  })
  .delete("/", deleteBillingCode.handler, {
    body: deleteBillingCode.config.body,
    resourceSetUpdated: billingCodeRealtimeUpdates,
    permissions: deleteBillingCode.config.permissions,
  });
