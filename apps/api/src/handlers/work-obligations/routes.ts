import acknowledgeWorkObligation from "@/api/handlers/work-obligations/acknowledgements/create";
import transitionWorkObligation from "@/api/handlers/work-obligations/transition";
import updateWorkObligation from "@/api/handlers/work-obligations/update";
import { routes } from "@/api/http/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const workObligationsRoute = routes(
  {
    "/:entityId": { PATCH: updateWorkObligation },
    "/:entityId/acknowledge": { POST: acknowledgeWorkObligation },
    "/:entityId/transition": { POST: transitionWorkObligation },
  },
  {
    prefix: "/work-obligations/:workspaceId",
    middleware: [deploymentFeatureGate("FEATURE_GOVERNED_WORKFLOW")],
  },
);
