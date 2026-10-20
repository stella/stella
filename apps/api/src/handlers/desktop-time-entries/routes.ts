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
  .get(
    "/matter-candidates",
    {
      response: candidates.config.response,
    },
    candidates.handler,
  )
  .put(
    "/time-entries/batch",
    {
      body: batch.config.body,
      response: batch.config.response,
    },
    batch.handler,
  )
  .put(
    "/time-entries/batch/status",
    {
      body: batchStatus.config.body,
      response: batchStatus.config.response,
    },
    batchStatus.handler,
  )
  .get(
    "/matters",
    {
      query: matters.config.query,
      response: matters.config.response,
    },
    matters.handler,
  )
  .put(
    "/time-entries/:workspaceId",
    {
      params: create.config.params,
      body: create.config.body,
      response: create.config.response,
    },
    create.handler,
  );
