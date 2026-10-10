import Elysia from "elysia";

import approveTimeEntries from "@/api/handlers/time-entries/approval-queue/approve";
import listApprovalQueue from "@/api/handlers/time-entries/approval-queue/list";
import returnTimeEntry from "@/api/handlers/time-entries/approval-queue/return";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

export const timeApprovalQueueRoute = new Elysia({ prefix: "/v1/time-entries" })
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
  .get("/approval-queue", listApprovalQueue.handler, {
    permissions: listApprovalQueue.config.permissions,
    query: listApprovalQueue.config.query,
  })
  .post("/approve", approveTimeEntries.handler, {
    permissions: approveTimeEntries.config.permissions,
    body: approveTimeEntries.config.body,
  })
  .post("/approval-queue/return", returnTimeEntry.handler, {
    permissions: returnTimeEntry.config.permissions,
    body: returnTimeEntry.config.body,
  });
