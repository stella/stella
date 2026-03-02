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
import { workspaceAccessMacro } from "@/api/lib/auth";
import { tNanoid } from "@/api/lib/custom-schema";
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
  .get(
    "/:invoiceId",
    (ctx) =>
      readInvoiceByIdHandler({
        workspaceId: ctx.workspaceId,
        invoiceId: ctx.params.invoiceId,
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
  )
  .patch(
    "/:invoiceId",
    (ctx) =>
      updateInvoiceHandler({
        workspaceId: ctx.workspaceId,
        invoiceId: ctx.params.invoiceId,
        body: ctx.body,
      }),
    {
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
    (ctx) =>
      transitionInvoiceHandler({
        workspaceId: ctx.workspaceId,
        invoiceId: ctx.params.invoiceId,
        body: ctx.body,
      }),
    {
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
    (ctx) =>
      deleteInvoiceHandler({
        workspaceId: ctx.workspaceId,
        invoiceId: ctx.params.invoiceId,
      }),
    {
      invalidateQuery: true,
      params: t.Object({
        workspaceId: tNanoid,
        invoiceId: tNanoid,
      }),
    },
  )
  .post(
    "/:invoiceId/entries",
    (ctx) =>
      addEntriesHandler({
        workspaceId: ctx.workspaceId,
        invoiceId: ctx.params.invoiceId,
        body: ctx.body,
      }),
    {
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
    (ctx) =>
      removeEntriesHandler({
        workspaceId: ctx.workspaceId,
        invoiceId: ctx.params.invoiceId,
        body: ctx.body,
      }),
    {
      invalidateQuery: true,
      params: t.Object({
        workspaceId: tNanoid,
        invoiceId: tNanoid,
      }),
      body: removeEntriesBodySchema,
    },
  );
