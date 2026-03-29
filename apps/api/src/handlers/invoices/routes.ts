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
    query: readInvoices.config.query,
  })
  .get("/:invoiceId", readInvoiceById.handler, {
    params: readInvoiceById.config.params,
  })
  .put("/", createInvoice.handler, {
    invalidateQuery: true,
    body: createInvoice.config.body,
  })
  .patch("/:invoiceId", updateInvoice.handler, {
    invalidateQuery: true,
    params: updateInvoice.config.params,
    body: updateInvoice.config.body,
  })
  .post("/:invoiceId/transition", transitionInvoice.handler, {
    invalidateQuery: true,
    params: transitionInvoice.config.params,
    body: transitionInvoice.config.body,
  })
  .delete("/:invoiceId", deleteInvoice.handler, {
    invalidateQuery: true,
    params: deleteInvoice.config.params,
  })
  .post("/:invoiceId/entries", addEntries.handler, {
    invalidateQuery: true,
    params: addEntries.config.params,
    body: addEntries.config.body,
  })
  .delete("/:invoiceId/entries", removeEntries.handler, {
    invalidateQuery: true,
    params: removeEntries.config.params,
    body: removeEntries.config.body,
  });
