import { mount, routes } from "@/api/http/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
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
import narrative from "./narrative";

export const desktopTimeEntriesRoute = mount(
  [
    routes(
      {
        "/billing-drafts/settings": { GET: readBillingDraftSettings },
        "/billing-drafts": { POST: billingDrafts },
      },
      { middleware: [deploymentFeatureGate("FEATURE_TIME_BILLING")] },
    ),
    routes({
      // A consent withdrawal stays reachable whatever the deployment flag
      // says; the handler refuses every other change without the feature.
      "/billing-drafts/settings": { PUT: updateBillingDraftSettings },
      "/matter-candidates": { GET: candidates },
      "/time-entries/batch": { PUT: batch },
      "/time-entries/batch/status": { PUT: batchStatus },
      "/time-entries/narrative": { POST: narrative },
      "/matters": { GET: matters },
      "/time-entries/:workspaceId": { PUT: create },
    }),
  ],
  {
    prefix: "/v1/desktop",
    middleware: [rateLimit(createStandardApiRateLimitOptions())],
  },
);
