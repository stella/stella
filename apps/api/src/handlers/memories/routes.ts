import Elysia from "elysia";

import createMemory from "@/api/handlers/memories/create";
import createFirmMemory from "@/api/handlers/memories/create-firm";
import deleteMemory from "@/api/handlers/memories/delete";
import listMemories from "@/api/handlers/memories/list";
import updateMemory from "@/api/handlers/memories/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { featureAccessGate } from "@/api/lib/auth/feature-access/route";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
import { AI_MEMORY_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

// Mounted at `/v1/memories` directly at the root because folding another
// `.use()` into the large `/v1` group tips Elysia's inferred type past
// TypeScript's complexity threshold. It still shares that group's standard
// API limiter scope, so callers cannot bypass or double the budget.
export const memoriesRoute = new Elysia({
  prefix: "/v1/memories",
})
  .use(
    deploymentFeatureGate(() =>
      isDeploymentFeatureEnabled("FEATURE_AI_MEMORY"),
    ),
  )
  .use(featureAccessGate(AI_MEMORY_FEATURE_ID))
  .use(rateLimit(createStandardApiRateLimitOptions()))
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listMemories.handler, {
    query: listMemories.config.query,
    permissions: listMemories.config.permissions,
    accountAccess: listMemories.config.accountAccess,
  })
  .post("/", createMemory.handler, {
    body: createMemory.config.body,
    permissions: createMemory.config.permissions,
    accountAccess: createMemory.config.accountAccess,
  })
  .post("/firm", createFirmMemory.handler, {
    body: createFirmMemory.config.body,
    permissions: createFirmMemory.config.permissions,
    accountAccess: createFirmMemory.config.accountAccess,
  })
  .patch("/:memoryId", updateMemory.handler, {
    body: updateMemory.config.body,
    params: updateMemory.config.params,
    permissions: updateMemory.config.permissions,
    accountAccess: updateMemory.config.accountAccess,
  })
  .delete("/:memoryId", deleteMemory.handler, {
    params: deleteMemory.config.params,
    permissions: deleteMemory.config.permissions,
    accountAccess: deleteMemory.config.accountAccess,
  });
