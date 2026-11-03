import createClientInvoice from "@/api/handlers/client-invoices/create";
import prefillClientInvoice from "@/api/handlers/client-invoices/prefill";
import { routes } from "@/api/http/route";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const clientInvoicesRoute = routes(
  {
    "/": { PUT: createClientInvoice },
    "/prefill": { GET: prefillClientInvoice },
  },
  {
    prefix: "/client-invoices/:clientId",
    middleware: [
      deploymentFeatureGate("FEATURE_TIME_BILLING"),
      featureAccessGate("time-billing"),
    ],
  },
);
