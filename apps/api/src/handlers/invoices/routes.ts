import Elysia from "elysia";

import {
  createInvoiceBodySchema,
  createInvoiceHandler,
} from "@/api/handlers/invoices/create";
import {
  readInvoicesHandler,
  readInvoicesQuerySchema,
} from "@/api/handlers/invoices/read";
import { workspaceAccessMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const invoicesRoute = new Elysia({
  prefix: "/invoices/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(invalidateQuery)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get(
    "/",
    (ctx) =>
      readInvoicesHandler({
        workspaceId: ctx.workspaceId,
        query: ctx.query,
      }),
    {
      query: readInvoicesQuerySchema,
    },
  )
  .put(
    "/",
    (ctx) =>
      createInvoiceHandler({
        organizationId: ctx.session.activeOrganizationId,
        workspaceId: ctx.workspaceId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      body: createInvoiceBodySchema,
    },
  );
