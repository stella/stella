import Elysia from "elysia";

import createInternalTimeEntry from "@/api/handlers/time-entries/internal/create";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

export const internalTimeEntriesRoute = new Elysia({
  prefix: "/v1/time-entries/internal",
})
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
  .post("/", createInternalTimeEntry.handler, {
    permissions: createInternalTimeEntry.config.permissions,
    body: createInternalTimeEntry.config.body,
  });
