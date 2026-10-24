import archiveVatRate from "@/api/handlers/vat-rates/archive";
import createVatRate from "@/api/handlers/vat-rates/create";
import listVatRates from "@/api/handlers/vat-rates/list";
import applyVatRatePreset from "@/api/handlers/vat-rates/presets/create";
import updateVatRate from "@/api/handlers/vat-rates/update";
import { routes } from "@/api/http/route";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const vatRateRoute = routes(
  {
    "/": { GET: listVatRates, POST: createVatRate },
    "/apply-preset": { POST: applyVatRatePreset },
    "/:vatRateId": { PATCH: updateVatRate },
    "/:vatRateId/archive": { POST: archiveVatRate },
  },
  {
    prefix: "/vat-rates",
    middleware: [
      deploymentFeatureGate("FEATURE_TIME_BILLING"),
      featureAccessGate("time-billing"),
    ],
  },
);
