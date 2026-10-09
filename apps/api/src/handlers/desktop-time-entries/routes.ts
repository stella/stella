import Elysia from "elysia";

import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import create from "./create";
import matters from "./matters";

export const desktopTimeEntriesRoute = new Elysia({
  prefix: "/v1/desktop",
})
  .use(rateLimit(createStandardApiRateLimitOptions()))
  .get("/matters", matters.handler, {
    query: matters.config.query,
    response: matters.config.response,
  })
  .put("/time-entries/:workspaceId", create.handler, {
    params: create.config.params,
    body: create.config.body,
    response: create.config.response,
  });
