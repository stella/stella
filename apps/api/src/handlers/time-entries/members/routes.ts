import Elysia from "elysia";

import { authMacro, permissionMacro } from "@/api/lib/auth";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import updateDailyTarget from "./daily-target/update";

export const memberTimeTargetsRoute = new Elysia({
  prefix: "/v1/time-entries/members",
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
  .put("/:userId/daily-target", updateDailyTarget.handler, {
    permissions: updateDailyTarget.config.permissions,
    params: updateDailyTarget.config.params,
    body: updateDailyTarget.config.body,
  });
