import createBillingCode from "@/api/handlers/billing-codes/create";
import deleteBillingCode from "@/api/handlers/billing-codes/delete";
import readBillingCodes from "@/api/handlers/billing-codes/list";
import updateBillingCode from "@/api/handlers/billing-codes/update";
import { routes } from "@/api/http/route";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const billingCodesRoute = routes(
  {
    "/": {
      GET: readBillingCodes,
      PUT: createBillingCode,
      PATCH: updateBillingCode,
      DELETE: deleteBillingCode,
    },
  },
  {
    prefix: "/billing-codes/:workspaceId",
    middleware: [
      deploymentFeatureGate("FEATURE_TIME_BILLING"),
      featureAccessGate("time-billing"),
    ],
  },
);
