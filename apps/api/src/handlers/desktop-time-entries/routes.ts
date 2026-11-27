import { mount, routes } from "@/api/http/route";
import {
  deploymentFeatureGate,
  deploymentFeatureGateExcept,
} from "@/api/lib/deployment-feature-route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import batch from "./batch";
import batchStatus from "./batch-status";
import {
  consentWithdrawalException,
  readBillingDraftSettings,
  updateBillingDraftSettings,
} from "./billing-draft-settings";
import billingDrafts from "./billing-drafts";
import calendarEvents from "./calendar-events";
import candidates from "./candidates";
import create from "./create";
import dayEntries from "./day-entries";
import matters from "./matters";
import resolveMatters from "./resolve";

export const desktopTimeEntriesRoute = mount(
  [
    routes(
      {
        "/billing-drafts/settings": { GET: readBillingDraftSettings },
        "/billing-drafts": { POST: billingDrafts },
      },
      { middleware: [deploymentFeatureGate("FEATURE_TIME_BILLING")] },
    ),
    // A consent withdrawal stays reachable whatever the deployment flag says;
    // with the flag off every other request, a malformed one included,
    // answers as an absent route, and the handler refuses every other change
    // without the feature.
    routes(
      { "/billing-drafts/settings": { PUT: updateBillingDraftSettings } },
      {
        middleware: [
          deploymentFeatureGateExcept(
            "FEATURE_TIME_BILLING",
            consentWithdrawalException,
          ),
        ],
      },
    ),
    routes({
      "/calendar-events": { GET: calendarEvents },
      "/matter-candidates": { GET: candidates },
      "/matter-candidates/resolve": { GET: resolveMatters },
      "/day-entries": { GET: dayEntries },
      "/time-entries/batch": { PUT: batch },
      "/time-entries/batch/status": { PUT: batchStatus },
      "/matters": { GET: matters },
      "/time-entries/:workspaceId": { PUT: create },
    }),
  ],
  {
    prefix: "/v1/desktop",
    middleware: [rateLimit(createStandardApiRateLimitOptions())],
  },
);
