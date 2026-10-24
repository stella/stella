import Elysia from "elysia";

import createInvoice from "@/api/handlers/invoices/create";
import deleteInvoice from "@/api/handlers/invoices/delete";
import addEntries from "@/api/handlers/invoices/entries/add";
import removeEntries from "@/api/handlers/invoices/entries/remove";
import exportInvoices from "@/api/handlers/invoices/export";
import readInvoiceById from "@/api/handlers/invoices/get";
import createInvoiceLine from "@/api/handlers/invoices/lines/create";
import deleteInvoiceLine from "@/api/handlers/invoices/lines/delete";
import updateInvoiceLine from "@/api/handlers/invoices/lines/update";
import readInvoices from "@/api/handlers/invoices/list";
import exportInvoicePdf from "@/api/handlers/invoices/pdf/export";
import prefillInvoice from "@/api/handlers/invoices/prefill";
import transitionInvoice from "@/api/handlers/invoices/transition";
import updateInvoice from "@/api/handlers/invoices/update";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const invoicesRoute = new Elysia({
  prefix: "/invoices/:workspaceId",
})
  .use(
    deploymentFeatureGate(() =>
      isDeploymentFeatureEnabled("FEATURE_TIME_BILLING"),
    ),
  )
  .use(featureAccessGate("time-billing"))
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({
    validateWorkspaceAccess: true,
  })
  .get("/", readInvoices.handler, {
    permissions: readInvoices.config.permissions,
    accountAccess: readInvoices.config.accountAccess,
    query: readInvoices.config.query,
  })
  .get("/prefill", prefillInvoice.handler, {
    permissions: prefillInvoice.config.permissions,
    accountAccess: prefillInvoice.config.accountAccess,
    query: prefillInvoice.config.query,
  })
  .post("/export", exportInvoices.handler, {
    body: exportInvoices.config.body,
    params: exportInvoices.config.params,
    permissions: exportInvoices.config.permissions,
    accountAccess: exportInvoices.config.accountAccess,
  })
  .get("/:invoiceId", readInvoiceById.handler, {
    params: readInvoiceById.config.params,
    permissions: readInvoiceById.config.permissions,
    accountAccess: readInvoiceById.config.accountAccess,
  })
  .put("/", createInvoice.handler, {
    body: createInvoice.config.body,
    permissions: createInvoice.config.permissions,
    accountAccess: createInvoice.config.accountAccess,
  })
  .patch("/:invoiceId", updateInvoice.handler, {
    body: updateInvoice.config.body,
    params: updateInvoice.config.params,
    permissions: updateInvoice.config.permissions,
    accountAccess: updateInvoice.config.accountAccess,
  })
  .post("/:invoiceId/transition", transitionInvoice.handler, {
    body: transitionInvoice.config.body,
    params: transitionInvoice.config.params,
    permissions: transitionInvoice.config.permissions,
    accountAccess: transitionInvoice.config.accountAccess,
  })
  .delete("/:invoiceId", deleteInvoice.handler, {
    params: deleteInvoice.config.params,
    permissions: deleteInvoice.config.permissions,
    accountAccess: deleteInvoice.config.accountAccess,
  })
  .post("/:invoiceId/entries", addEntries.handler, {
    body: addEntries.config.body,
    params: addEntries.config.params,
    permissions: addEntries.config.permissions,
    accountAccess: addEntries.config.accountAccess,
  })
  .delete("/:invoiceId/entries", removeEntries.handler, {
    body: removeEntries.config.body,
    params: removeEntries.config.params,
    permissions: removeEntries.config.permissions,
    accountAccess: removeEntries.config.accountAccess,
  })
  .post("/:invoiceId/lines", createInvoiceLine.handler, {
    body: createInvoiceLine.config.body,
    params: createInvoiceLine.config.params,
    permissions: createInvoiceLine.config.permissions,
    accountAccess: createInvoiceLine.config.accountAccess,
  })
  .patch("/:invoiceId/lines/:lineId", updateInvoiceLine.handler, {
    body: updateInvoiceLine.config.body,
    params: updateInvoiceLine.config.params,
    permissions: updateInvoiceLine.config.permissions,
    accountAccess: updateInvoiceLine.config.accountAccess,
  })
  .delete("/:invoiceId/lines/:lineId", deleteInvoiceLine.handler, {
    params: deleteInvoiceLine.config.params,
    permissions: deleteInvoiceLine.config.permissions,
    accountAccess: deleteInvoiceLine.config.accountAccess,
  })
  .post("/:invoiceId/pdf", exportInvoicePdf.handler, {
    params: exportInvoicePdf.config.params,
    permissions: exportInvoicePdf.config.permissions,
    accountAccess: exportInvoicePdf.config.accountAccess,
  });
