import archiveNumberSeries from "@/api/handlers/number-series/archive";
import createNumberSeries from "@/api/handlers/number-series/create";
import updateNumberSeriesDefault from "@/api/handlers/number-series/default/update";
import getNumberSeries from "@/api/handlers/number-series/get";
import listNumberSeries from "@/api/handlers/number-series/list";
import previewNumberSeries from "@/api/handlers/number-series/preview";
import updateNumberSeries from "@/api/handlers/number-series/update";
import { routes } from "@/api/http/route";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const numberSeriesRoute = routes(
  {
    "/": { GET: listNumberSeries, POST: createNumberSeries },
    "/:numberSeriesId": { GET: getNumberSeries, PATCH: updateNumberSeries },
    "/:numberSeriesId/preview": { GET: previewNumberSeries },
    "/:numberSeriesId/default": { POST: updateNumberSeriesDefault },
    "/:numberSeriesId/archive": { POST: archiveNumberSeries },
  },
  {
    prefix: "/number-series",
    middleware: [
      deploymentFeatureGate("FEATURE_TIME_BILLING"),
      featureAccessGate("time-billing"),
    ],
  },
);
