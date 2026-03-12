import Elysia, { t } from "elysia";

import {
  addEntriesBodySchema,
  addEntriesHandler,
} from "@/api/handlers/invoices/add-entries";
import {
  createInvoiceBodySchema,
  createInvoiceHandler,
} from "@/api/handlers/invoices/create";
import { deleteInvoiceHandler } from "@/api/handlers/invoices/delete";
import {
  readInvoicesHandler,
  readInvoicesQuerySchema,
} from "@/api/handlers/invoices/read";
import { readInvoiceByIdHandler } from "@/api/handlers/invoices/read-by-id";
import {
  removeEntriesBodySchema,
  removeEntriesHandler,
} from "@/api/handlers/invoices/remove-entries";
import {
  transitionInvoiceBodySchema,
  transitionInvoiceHandler,
} from "@/api/handlers/invoices/transition";
import {
  updateInvoiceBodySchema,
  updateInvoiceHandler,
} from "@/api/handlers/invoices/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { tNanoid } from "@/api/lib/custom-schema";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

export const invoicesRoute = new Elysia({
  prefix: "/invoices/:workspaceId",
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
      await readInvoicesHandler({
        workspaceId: ctx.workspaceId,
        query: ctx.query,
        scopedDb: ctx.scopedDb,
      }),
    {
      query: readInvoicesQuerySchema,
    },
  )
  .get(
    "/:invoiceId",
    async (ctx) =>
      await readInvoiceByIdHandler({
        workspaceId: ctx.workspaceId,
        invoiceId: ctx.params.invoiceId,
        scopedDb: ctx.scopedDb,
      }),
    {
      params: t.Object({
        workspaceId: tNanoid,
        invoiceId: tNanoid,
      }),
    },
  )
  .put(
    "/",
    async (ctx) =>
      await createInvoiceHandler({
        organizationId: ctx.session.activeOrganizationId,
        workspaceId: ctx.workspaceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { invoice: ["create"] },
      invalidateQuery: true,
      body: createInvoiceBodySchema,
    },
  )
  .patch(
    "/:invoiceId",
    async (ctx) =>
      await updateInvoiceHandler({
        workspaceId: ctx.workspaceId,
        invoiceId: ctx.params.invoiceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { invoice: ["update"] },
      invalidateQuery: true,
      params: t.Object({
        workspaceId: tNanoid,
        invoiceId: tNanoid,
      }),
      body: updateInvoiceBodySchema,
    },
  )
  .post(
    "/:invoiceId/transition",
    async (ctx) =>
      await transitionInvoiceHandler({
        workspaceId: ctx.workspaceId,
        invoiceId: ctx.params.invoiceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { invoice: ["update"] },
      invalidateQuery: true,
      params: t.Object({
        workspaceId: tNanoid,
        invoiceId: tNanoid,
      }),
      body: transitionInvoiceBodySchema,
    },
  )
  .delete(
    "/:invoiceId",
    async (ctx) =>
      await deleteInvoiceHandler({
        workspaceId: ctx.workspaceId,
        invoiceId: ctx.params.invoiceId,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { invoice: ["delete"] },
      invalidateQuery: true,
      params: t.Object({
        workspaceId: tNanoid,
        invoiceId: tNanoid,
      }),
    },
  )
  .post(
    "/:invoiceId/entries",
    async (ctx) =>
      await addEntriesHandler({
        workspaceId: ctx.workspaceId,
        invoiceId: ctx.params.invoiceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { invoice: ["update"] },
      invalidateQuery: true,
      params: t.Object({
        workspaceId: tNanoid,
        invoiceId: tNanoid,
      }),
      body: addEntriesBodySchema,
    },
  )
  .delete(
    "/:invoiceId/entries",
    async (ctx) =>
      await removeEntriesHandler({
        workspaceId: ctx.workspaceId,
        invoiceId: ctx.params.invoiceId,
        body: ctx.body,
        scopedDb: ctx.scopedDb,
      }),
    {
      permissions: { invoice: ["update"] },
      invalidateQuery: true,
      params: t.Object({
        workspaceId: tNanoid,
        invoiceId: tNanoid,
      }),
      body: removeEntriesBodySchema,
    },
  );
