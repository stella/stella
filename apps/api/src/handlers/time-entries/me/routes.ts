import updateDailyTarget from "@/api/handlers/time-entries/me/daily-target/update";
import listMyTimeEntries from "@/api/handlers/time-entries/me/list";
import listMySuggestionRange from "@/api/handlers/time-entries/me/suggestions/list";
import { routes } from "@/api/http/route";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

// Mounted before the matter route so /me is a static path, with the same API
// rate limit applied outside the large /v1 route group.
export const myTimeEntriesRoute = routes(
  {
    "/": { GET: listMyTimeEntries },
    "/daily-target": { PUT: updateDailyTarget },
    "/suggestions": { GET: listMySuggestionRange },
  },
  {
    prefix: "/v1/time-entries/me",
    middleware: [
      deploymentFeatureGate("FEATURE_TIME_BILLING"),
      featureAccessGate("time-billing"),
      rateLimit(createStandardApiRateLimitOptions()),
    ],
  },
);
