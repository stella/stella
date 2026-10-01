import Elysia from "elysia";

import createInternalTimeEntry from "@/api/handlers/time-entries/internal/create";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

export const internalTimeEntriesRoute = new Elysia({
  prefix: "/v1/time-entries/internal",
})
  .use(rateLimit(createStandardApiRateLimitOptions()))
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .post("/", createInternalTimeEntry.handler, {
    permissions: createInternalTimeEntry.config.permissions,
    body: createInternalTimeEntry.config.body,
  });
