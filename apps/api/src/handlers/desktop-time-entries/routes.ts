import { routes } from "@/api/http/route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import batch from "./batch";
import batchStatus from "./batch-status";
import candidates from "./candidates";
import create from "./create";
import matters from "./matters";

export const desktopTimeEntriesRoute = routes(
  {
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
