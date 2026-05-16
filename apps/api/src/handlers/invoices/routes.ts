import Elysia from "elysia";

import addEntries from "@/api/handlers/invoices/add-entries";
import createInvoice from "@/api/handlers/invoices/create";
import deleteInvoice from "@/api/handlers/invoices/delete";
import readInvoices from "@/api/handlers/invoices/read";
import readInvoiceById from "@/api/handlers/invoices/read-by-id";
import removeEntries from "@/api/handlers/invoices/remove-entries";
import transitionInvoice from "@/api/handlers/invoices/transition";
import updateInvoice from "@/api/handlers/invoices/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
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
  .get("/", readInvoices.handler, {
    permissions: readInvoices.config.permissions,
    query: readInvoices.config.query,
  })
  .get("/:invoiceId", readInvoiceById.handler, {
    params: readInvoiceById.config.params,
    permissions: readInvoiceById.config.permissions,
  })
  .put("/", createInvoice.handler, {
    body: createInvoice.config.body,
    invalidateQuery: true,
    permissions: createInvoice.config.permissions,
  })
  .patch("/:invoiceId", updateInvoice.handler, {
    body: updateInvoice.config.body,
    invalidateQuery: true,
    params: updateInvoice.config.params,
    permissions: updateInvoice.config.permissions,
  })
  .post("/:invoiceId/transition", transitionInvoice.handler, {
    body: transitionInvoice.config.body,
    invalidateQuery: true,
    params: transitionInvoice.config.params,
    permissions: transitionInvoice.config.permissions,
  })
  .delete("/:invoiceId", deleteInvoice.handler, {
    invalidateQuery: true,
    params: deleteInvoice.config.params,
    permissions: deleteInvoice.config.permissions,
  })
  .post("/:invoiceId/entries", addEntries.handler, {
    body: addEntries.config.body,
    invalidateQuery: true,
    params: addEntries.config.params,
    permissions: addEntries.config.permissions,
  })
  .delete("/:invoiceId/entries", removeEntries.handler, {
    body: removeEntries.config.body,
    invalidateQuery: true,
    params: removeEntries.config.params,
    permissions: removeEntries.config.permissions,
  });
