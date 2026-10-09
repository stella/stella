import Elysia from "elysia";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import { authMacro, permissionMacro } from "@/api/lib/auth";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import read from "./read";
import report from "./report";

export const desktopPresenceRoute = new Elysia({
  prefix: `${STELLA_API_VERSION_PREFIX}/desktop/presence`,
})
  .use(rateLimit(createStandardApiRateLimitOptions()))
  .post("/", report.handler, {
    body: report.config.body,
    response: report.config.response,
  })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", read.handler, {
    permissions: read.config.permissions,
    response: read.config.response,
  });
