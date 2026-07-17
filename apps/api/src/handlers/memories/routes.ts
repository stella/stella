import Elysia from "elysia";

import { env } from "@/api/env";
import createMemory from "@/api/handlers/memories/create";
import createFirmMemory from "@/api/handlers/memories/create-firm";
import listMemories from "@/api/handlers/memories/list";
import updateMemory from "@/api/handlers/memories/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import {
  scopedRateLimitKey,
  standardApiRateLimitContext,
} from "@/api/lib/rate-limit/rate-limit";

// Mounted at `/v1/memories` directly at the root because folding another
// `.use()` into the large `/v1` group tips Elysia's inferred type past
// TypeScript's complexity threshold. It still shares that group's standard
// API limiter context and key, so callers cannot bypass or double the budget.
export const memoriesRoute = new Elysia({
  prefix: "/v1/memories",
})
  .onBeforeHandle(({ request, server, set }) => {
    if (env.E2E_DISABLE_AUTH_RATE_LIMIT) {
      return;
    }
    // Consume the exact same key and counter store as the standard `/v1`
    // plugin. A small hook avoids attaching a second deeply generic Elysia
    // plugin while preserving one shared abuse budget.
    const key = scopedRateLimitKey("api", request, server);
    const rate = standardApiRateLimitContext.increment(
      key,
      API_RATE_LIMITS.api.duration,
    );
    if (rate.count > API_RATE_LIMITS.api.max) {
      set.headers["retry-after"] = String(
        Math.max(1, Math.ceil((rate.nextReset.getTime() - Date.now()) / 1000)),
      );
      throw new HandlerError({ status: 429, message: "Too many requests" });
    }
  })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listMemories.handler, {
    query: listMemories.config.query,
    permissions: listMemories.config.permissions,
  })
  .post("/", createMemory.handler, {
    body: createMemory.config.body,
    permissions: createMemory.config.permissions,
  })
  .post("/firm", createFirmMemory.handler, {
    body: createFirmMemory.config.body,
    permissions: createFirmMemory.config.permissions,
  })
  .patch("/:memoryId", updateMemory.handler, {
    body: updateMemory.config.body,
    params: updateMemory.config.params,
    permissions: updateMemory.config.permissions,
  });
