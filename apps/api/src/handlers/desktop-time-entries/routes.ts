import Elysia from "elysia";

import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import batch from "./batch";
import batchStatus from "./batch-status";
import candidates from "./candidates";
import create from "./create";
import matters from "./matters";

export const desktopTimeEntriesRoute = new Elysia({
  prefix: "/v1/desktop",
})
  .use(rateLimit(createStandardApiRateLimitOptions()))
  .get("/matter-candidates", candidates.handler, {
    response: candidates.config.response,
  })
  .put("/time-entries/batch", batch.handler, {
    body: batch.config.body,
    response: batch.config.response,
  })
  .put("/time-entries/batch/status", batchStatus.handler, {
    body: batchStatus.config.body,
    response: batchStatus.config.response,
  })
  .get("/matters", matters.handler, {
    query: matters.config.query,
    response: matters.config.response,
  })
  .put("/time-entries/:workspaceId", create.handler, {
    params: create.config.params,
    body: create.config.body,
    response: create.config.response,
  });
