import approveTimeEntries from "@/api/handlers/time-entries/approval-queue/approve";
import listApprovalQueue from "@/api/handlers/time-entries/approval-queue/list";
import returnTimeEntries from "@/api/handlers/time-entries/approval-queue/return";
import { routes } from "@/api/http/route";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

export const timeApprovalQueueRoute = routes(
  {
    "/approval-queue": { GET: listApprovalQueue },
    "/approve": { POST: approveTimeEntries },
    "/approval-queue/return": { POST: returnTimeEntries },
  },
  {
    prefix: "/v1/time-entries",
    middleware: [
      deploymentFeatureGate("FEATURE_TIME_BILLING"),
      featureAccessGate("time-billing"),
      rateLimit(createStandardApiRateLimitOptions()),
    ],
  },
);
