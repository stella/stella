import Elysia from "elysia";

import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import billingDraftSettings from "./billing-draft-settings";
import billingDrafts from "./billing-drafts";
import create from "./create";
import matters from "./matters";

export const desktopTimeEntriesRoute = new Elysia({
  prefix: "/v1/desktop",
})
  .use(rateLimit(createStandardApiRateLimitOptions()))
  .get("/billing-drafts/settings", billingDraftSettings.read.handler, {
    response: billingDraftSettings.read.config.response,
  })
  .put("/billing-drafts/settings", billingDraftSettings.update.handler, {
    body: billingDraftSettings.update.config.body,
    response: billingDraftSettings.update.config.response,
  })
  .post("/billing-drafts", billingDrafts.handler, {
    body: billingDrafts.config.body,
    response: billingDrafts.config.response,
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
