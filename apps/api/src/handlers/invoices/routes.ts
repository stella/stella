import Elysia from "elysia";

import { RESOURCE_TYPE } from "@stll/api-contract";

import addEntries from "@/api/handlers/invoices/add-entries";
import createInvoice from "@/api/handlers/invoices/create";
import deleteInvoice from "@/api/handlers/invoices/delete";
import readInvoiceById from "@/api/handlers/invoices/get";
import readInvoices from "@/api/handlers/invoices/list";
import removeEntries from "@/api/handlers/invoices/remove-entries";
import transitionInvoice from "@/api/handlers/invoices/transition";
import updateInvoice from "@/api/handlers/invoices/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import {
  resourceRealtime,
  workspaceResourceSetUpdates,
} from "@/api/lib/resource-realtime-macro";

const invoiceRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.INVOICE,
);

export const invoicesRoute = new Elysia({
  prefix: "/invoices/:workspaceId",
})
  .use(workspaceAccessMacro)
  .use(resourceRealtime)
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
    resourceSetUpdated: invoiceRealtimeUpdates,
    permissions: createInvoice.config.permissions,
  })
  .patch("/:invoiceId", updateInvoice.handler, {
    body: updateInvoice.config.body,
    resourceSetUpdated: invoiceRealtimeUpdates,
    params: updateInvoice.config.params,
    permissions: updateInvoice.config.permissions,
  })
  .post("/:invoiceId/transition", transitionInvoice.handler, {
    body: transitionInvoice.config.body,
    resourceSetUpdated: invoiceRealtimeUpdates,
    params: transitionInvoice.config.params,
    permissions: transitionInvoice.config.permissions,
  })
  .delete("/:invoiceId", deleteInvoice.handler, {
    resourceSetUpdated: invoiceRealtimeUpdates,
    params: deleteInvoice.config.params,
    permissions: deleteInvoice.config.permissions,
  })
  .post("/:invoiceId/entries", addEntries.handler, {
    body: addEntries.config.body,
    resourceSetUpdated: invoiceRealtimeUpdates,
    params: addEntries.config.params,
    permissions: addEntries.config.permissions,
  })
  .delete("/:invoiceId/entries", removeEntries.handler, {
    body: removeEntries.config.body,
    resourceSetUpdated: invoiceRealtimeUpdates,
    params: removeEntries.config.params,
    permissions: removeEntries.config.permissions,
  });
