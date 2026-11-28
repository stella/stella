import createInternalTimeEntry from "@/api/handlers/time-entries/internal/create";
import { routes } from "@/api/http/route";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

export const internalTimeEntriesRoute = routes(
  {
    "/": { POST: createInternalTimeEntry },
  },
  {
    prefix: "/v1/time-entries/internal",
    deployment: { type: "flag", flag: "FEATURE_TIME_BILLING" },
    middleware: [
      featureAccessGate("time-billing"),
      rateLimit(createStandardApiRateLimitOptions()),
    ],
  },
);
