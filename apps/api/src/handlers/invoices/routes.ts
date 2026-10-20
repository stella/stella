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
  .get(
    "/",
    {
      permissions: readInvoices.config.permissions,
      query: readInvoices.config.query,
    },
    readInvoices.handler,
  )
  .get(
    "/prefill",
    {
      permissions: prefillInvoice.config.permissions,
      query: prefillInvoice.config.query,
    },
    prefillInvoice.handler,
  )
  .post(
    "/export",
    {
      body: exportInvoices.config.body,
      params: exportInvoices.config.params,
      permissions: exportInvoices.config.permissions,
    },
    exportInvoices.handler,
  )
  .get(
    "/:invoiceId",
    {
      params: readInvoiceById.config.params,
      permissions: readInvoiceById.config.permissions,
    },
    readInvoiceById.handler,
  )
  .put(
    "/",
    {
      body: createInvoice.config.body,
      permissions: createInvoice.config.permissions,
    },
    createInvoice.handler,
  )
  .patch(
    "/:invoiceId",
    {
      body: updateInvoice.config.body,
      params: updateInvoice.config.params,
      permissions: updateInvoice.config.permissions,
    },
    updateInvoice.handler,
  )
  .post(
    "/:invoiceId/transition",
    {
      body: transitionInvoice.config.body,
      params: transitionInvoice.config.params,
      permissions: transitionInvoice.config.permissions,
    },
    transitionInvoice.handler,
  )
  .delete(
    "/:invoiceId",
    {
      params: deleteInvoice.config.params,
      permissions: deleteInvoice.config.permissions,
    },
    deleteInvoice.handler,
  )
  .post(
    "/:invoiceId/entries",
    {
      body: addEntries.config.body,
      params: addEntries.config.params,
      permissions: addEntries.config.permissions,
    },
    addEntries.handler,
  )
  .delete(
    "/:invoiceId/entries",
    {
      body: removeEntries.config.body,
      params: removeEntries.config.params,
      permissions: removeEntries.config.permissions,
    },
    removeEntries.handler,
  )
  .post(
    "/:invoiceId/lines",
    {
      body: createInvoiceLine.config.body,
      params: createInvoiceLine.config.params,
      permissions: createInvoiceLine.config.permissions,
    },
    createInvoiceLine.handler,
  )
  .patch(
    "/:invoiceId/lines/:lineId",
    {
      body: updateInvoiceLine.config.body,
      params: updateInvoiceLine.config.params,
      permissions: updateInvoiceLine.config.permissions,
    },
    updateInvoiceLine.handler,
  )
  .delete(
    "/:invoiceId/lines/:lineId",
    {
      params: deleteInvoiceLine.config.params,
      permissions: deleteInvoiceLine.config.permissions,
    },
    deleteInvoiceLine.handler,
  )
  .post(
    "/:invoiceId/pdf",
    {
      params: exportInvoicePdf.config.params,
      permissions: exportInvoicePdf.config.permissions,
    },
    exportInvoicePdf.handler,
  );
