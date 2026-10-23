import createMemory from "@/api/handlers/memories/create";
import createFirmMemory from "@/api/handlers/memories/create-firm";
import deleteMemory from "@/api/handlers/memories/delete";
import listMemories from "@/api/handlers/memories/list";
import updateMemory from "@/api/handlers/memories/update";
import { routes } from "@/api/http/route";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import { AI_MEMORY_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

// Mounted at `/v1/memories` from the root, outside the `/v1` group, behind its
// feature gates. It still shares that group's standard API limiter scope, so
// callers cannot bypass or double the budget.
export const memoriesRoute = routes(
  {
    "/": { GET: listMemories, POST: createMemory },
    "/firm": { POST: createFirmMemory },
    "/:memoryId": { PATCH: updateMemory, DELETE: deleteMemory },
  },
  {
    prefix: "/v1/memories",
    middleware: [
      deploymentFeatureGate("FEATURE_AI_MEMORY"),
      featureAccessGate(AI_MEMORY_FEATURE_ID),
      rateLimit(createStandardApiRateLimitOptions()),
    ],
  },
);
