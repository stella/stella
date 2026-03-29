import Elysia from "elysia";

import createBillingCode from "@/api/handlers/billing-codes/create";
import deleteBillingCode from "@/api/handlers/billing-codes/delete";
import readBillingCodes from "@/api/handlers/billing-codes/read";
import updateBillingCode from "@/api/handlers/billing-codes/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const billingCodesRoute = new Elysia({
  prefix: "/billing-codes/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get("/", readBillingCodes.handler, {
    query: readBillingCodes.config.query,
  })
  .put("/", createBillingCode.handler, {
    body: createBillingCode.config.body,
    invalidateQuery: true,
  })
  .patch("/", updateBillingCode.handler, {
    body: updateBillingCode.config.body,
    invalidateQuery: true,
  })
  .delete("/", deleteBillingCode.handler, {
    body: deleteBillingCode.config.body,
    invalidateQuery: true,
  });
