import Elysia from "elysia";

import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import batch from "./batch";
import batchStatus from "./batch-status";
import {
  readBillingDraftSettings,
  updateBillingDraftSettings,
} from "./billing-draft-settings";
import billingDrafts from "./billing-drafts";
import candidates from "./candidates";
import create from "./create";
import matters from "./matters";

export const desktopTimeEntriesRoute = new Elysia({
  prefix: "/v1/desktop",
})
  .use(rateLimit(createStandardApiRateLimitOptions()))
  .get("/billing-drafts/settings", readBillingDraftSettings.handler, {
    response: readBillingDraftSettings.config.response,
  })
  .put("/billing-drafts/settings", updateBillingDraftSettings.handler, {
    body: updateBillingDraftSettings.config.body,
    response: updateBillingDraftSettings.config.response,
  })
  .post("/billing-drafts", billingDrafts.handler, {
    body: billingDrafts.config.body,
    response: billingDrafts.config.response,
  })
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
