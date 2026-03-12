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
  .get(
    "/",
    async (ctx) =>
      await readBillingCodesHandler({
        workspaceId: ctx.workspaceId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    {
      query: readBillingCodesQuerySchema,
    },
  )
  .put(
    "/",
    async (ctx) =>
      await createBillingCodeHandler({
        organizationId: ctx.session.activeOrganizationId,
        workspaceId: ctx.workspaceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { billingCode: ["create"] },
      invalidateQuery: true,
      body: createBillingCodeBodySchema,
    },
  )
  .patch(
    "/",
    async (ctx) =>
      await updateBillingCodeHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { billingCode: ["update"] },
      invalidateQuery: true,
      body: updateBillingCodeBodySchema,
    },
  )
  .delete(
    "/",
    async (ctx) =>
      await deleteBillingCodeHandler({
        workspaceId: ctx.workspaceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { billingCode: ["delete"] },
      invalidateQuery: true,
      body: deleteBillingCodeBodySchema,
    },
  );
