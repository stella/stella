import Elysia from "elysia";

import updateDailyTarget from "@/api/handlers/time-entries/me/daily-target/update";
import listMyTimeEntries from "@/api/handlers/time-entries/me/list";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

// Mounted before the matter route so /me is a static path, with the same API
// rate limit applied outside the large /v1 route group.
export const myTimeEntriesRoute = new Elysia({ prefix: "/v1/time-entries/me" })
  .use(
    deploymentFeatureGate(() =>
      isDeploymentFeatureEnabled("FEATURE_TIME_BILLING"),
    ),
  )
  .use(featureAccessGate("time-billing"))
  .use(rateLimit(createStandardApiRateLimitOptions()))
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listMyTimeEntries.handler, {
    permissions: listMyTimeEntries.config.permissions,
    query: listMyTimeEntries.config.query,
  })
  .put("/daily-target", updateDailyTarget.handler, {
    permissions: updateDailyTarget.config.permissions,
    body: updateDailyTarget.config.body,
  });
