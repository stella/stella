import createClientInvoice from "@/api/handlers/client-invoices/create";
import prefillClientInvoice from "@/api/handlers/client-invoices/prefill";
import { routes } from "@/api/http/route";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";

export const clientInvoicesRoute = routes(
  {
    "/": { PUT: createClientInvoice },
    "/prefill": { GET: prefillClientInvoice },
  },
  {
    prefix: "/client-invoices/:clientId",
    deployment: { type: "flag", flag: "FEATURE_TIME_BILLING" },
    middleware: [featureAccessGate("time-billing")],
  },
);
