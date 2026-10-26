import { routes } from "@/api/http/route";
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

export const desktopTimeEntriesRoute = routes(
  {
    "/billing-drafts/settings": {
      GET: readBillingDraftSettings,
      PUT: updateBillingDraftSettings,
    },
    "/billing-drafts": { POST: billingDrafts },
    "/matter-candidates": { GET: candidates },
    "/time-entries/batch": { PUT: batch },
    "/time-entries/batch/status": { PUT: batchStatus },
    "/matters": { GET: matters },
    "/time-entries/:workspaceId": { PUT: create },
  },
  {
    prefix: "/v1/desktop",
    middleware: [rateLimit(createStandardApiRateLimitOptions())],
  },
);
