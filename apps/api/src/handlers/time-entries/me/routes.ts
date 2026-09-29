import Elysia from "elysia";

import listMyTimeEntries from "@/api/handlers/time-entries/me/list";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

// Mounted before the matter route so /me is a static path, with the same API
// rate limit applied outside the large /v1 route group.
export const myTimeEntriesRoute = new Elysia({ prefix: "/v1/time-entries/me" })
  .use(rateLimit(createStandardApiRateLimitOptions()))
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listMyTimeEntries.handler, {
    permissions: listMyTimeEntries.config.permissions,
    query: listMyTimeEntries.config.query,
  });
