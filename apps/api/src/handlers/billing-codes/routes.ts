import Elysia from "elysia";

import {
  createBillingCodeBodySchema,
  createBillingCodeHandler,
} from "@/api/handlers/billing-codes/create";
import {
  deleteBillingCodeBodySchema,
  deleteBillingCodeHandler,
} from "@/api/handlers/billing-codes/delete";
import {
  readBillingCodesHandler,
  readBillingCodesQuerySchema,
} from "@/api/handlers/billing-codes/read";
import {
  updateBillingCodeBodySchema,
  updateBillingCodeHandler,
} from "@/api/handlers/billing-codes/update";
import { workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const billingCodesRoute = new Elysia({
  prefix: "/billing-codes/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get(
    "/",
    (ctx) =>
      readBillingCodesHandler({
        workspaceId: ctx.workspaceId,
        query: ctx.query,
      }),
    {
      query: readBillingCodesQuerySchema,
    },
  )
  .put(
    "/",
    (ctx) =>
      createBillingCodeHandler({
        organizationId: ctx.session.activeOrganizationId,
        workspaceId: ctx.workspaceId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: createBillingCodeBodySchema,
    },
  )
  .patch(
    "/",
    (ctx) =>
      updateBillingCodeHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: updateBillingCodeBodySchema,
    },
  )
  .delete(
    "/",
    (ctx) =>
      deleteBillingCodeHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: deleteBillingCodeBodySchema,
    },
  );
