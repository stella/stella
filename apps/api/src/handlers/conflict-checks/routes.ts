import createConflictCheck from "@/api/handlers/conflict-checks/create";
import decideConflictCheck from "@/api/handlers/conflict-checks/decide";
import getConflictCheck from "@/api/handlers/conflict-checks/get";
import linkConflictCheckMatter from "@/api/handlers/conflict-checks/link-matter";
import listConflictChecks from "@/api/handlers/conflict-checks/list";
import { routes } from "@/api/http/route";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import { CONFLICT_CHECK_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

// Every check is recorded and audited; the rate limit also bounds how fast
// one member can probe the firm's matters through it.
export const conflictChecksRoute = routes(
  {
    "/": { GET: listConflictChecks, POST: createConflictCheck },
    "/:checkId": { GET: getConflictCheck },
    "/:checkId/decision": { POST: decideConflictCheck },
    "/:checkId/matter/:workspaceId": { PUT: linkConflictCheckMatter },
  },
  {
    prefix: "/v1/conflict-checks",
    middleware: [
      deploymentFeatureGate("FEATURE_CONFLICT_CHECK"),
      featureAccessGate(CONFLICT_CHECK_FEATURE_ID),
      rateLimit(createStandardApiRateLimitOptions()),
    ],
  },
);
