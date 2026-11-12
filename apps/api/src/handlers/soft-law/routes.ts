import readSoftLaw from "@/api/handlers/soft-law/get";
import searchSoftLaw from "@/api/handlers/soft-law/search";
import { routes } from "@/api/http/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

/** Signed-in reads of served regulator guidance. There is no anonymous route. */
export const softLawRoute = routes(
  {
    "/search": { GET: searchSoftLaw },
    "/:documentId": { GET: readSoftLaw },
  },
  {
    prefix: "/soft-law",
    middleware: [deploymentFeatureGate("FEATURE_PUBLIC_LAW")],
  },
);
