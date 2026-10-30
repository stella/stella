import { routes } from "@/api/http/route";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import updateDailyTarget from "./daily-target/update";

export const memberTimeTargetsRoute = routes(
  {
    "/:userId/daily-target": { PUT: updateDailyTarget },
  },
  {
    prefix: "/v1/time-entries/members",
    middleware: [
      deploymentFeatureGate("FEATURE_TIME_BILLING"),
      featureAccessGate("time-billing"),
      rateLimit(createStandardApiRateLimitOptions()),
    ],
  },
);
