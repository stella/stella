import createSavedTimeNarrative from "@/api/handlers/saved-time-narratives/create";
import deleteSavedTimeNarrative from "@/api/handlers/saved-time-narratives/delete";
import listSavedTimeNarratives from "@/api/handlers/saved-time-narratives/list";
import updateSavedTimeNarrative from "@/api/handlers/saved-time-narratives/update";
import { routes } from "@/api/http/route";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const savedTimeNarrativesRoute = routes(
  {
    "/": { GET: listSavedTimeNarratives, POST: createSavedTimeNarrative },
    "/:id": {
      PATCH: updateSavedTimeNarrative,
      DELETE: deleteSavedTimeNarrative,
    },
  },
  {
    prefix: "/saved-time-narratives",
    middleware: [
      deploymentFeatureGate("FEATURE_TIME_BILLING"),
      featureAccessGate("time-billing"),
    ],
  },
);
