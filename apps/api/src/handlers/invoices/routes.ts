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
import recordInvoicePayment from "@/api/handlers/invoices/payments/create";
import listInvoicePayments from "@/api/handlers/invoices/payments/list";
import voidInvoicePayment from "@/api/handlers/invoices/payments/void";
import exportInvoicePdf from "@/api/handlers/invoices/pdf/export";
import prefillInvoice from "@/api/handlers/invoices/prefill";
import sendInvoice from "@/api/handlers/invoices/sends/create";
import listInvoiceSends from "@/api/handlers/invoices/sends/list";
import revokeInvoiceSend from "@/api/handlers/invoices/sends/revoke";
import transitionInvoice from "@/api/handlers/invoices/transition";
import updateInvoice from "@/api/handlers/invoices/update";
import { routes } from "@/api/http/route";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const invoicesRoute = routes(
  {
    "/": { GET: readInvoices, PUT: createInvoice },
    "/prefill": { GET: prefillInvoice },
    "/export": { POST: exportInvoices },
    "/:invoiceId": {
      GET: readInvoiceById,
      PATCH: updateInvoice,
      DELETE: deleteInvoice,
    },
    "/:invoiceId/transition": { POST: transitionInvoice },
    "/:invoiceId/entries": { POST: addEntries, DELETE: removeEntries },
    "/:invoiceId/lines": { POST: createInvoiceLine },
    "/:invoiceId/lines/:lineId": {
      PATCH: updateInvoiceLine,
      DELETE: deleteInvoiceLine,
    },
    "/:invoiceId/pdf": { POST: exportInvoicePdf },
    "/:invoiceId/sends": { GET: listInvoiceSends, POST: sendInvoice },
    "/:invoiceId/sends/:sendId/revoke": { POST: revokeInvoiceSend },
    "/:invoiceId/payments": {
      GET: listInvoicePayments,
      POST: recordInvoicePayment,
    },
    "/:invoiceId/payments/:paymentId/void": { POST: voidInvoicePayment },
  },
  {
    prefix: "/invoices/:workspaceId",
    middleware: [
      deploymentFeatureGate("FEATURE_TIME_BILLING"),
      featureAccessGate("time-billing"),
    ],
  },
);
