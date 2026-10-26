import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import { routes } from "@/api/http/route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import read from "./read";
import report from "./report";

export const desktopPresenceRoute = routes(
  {
    "/": { POST: report, GET: read },
  },
  {
    prefix: `${STELLA_API_VERSION_PREFIX}/desktop/presence`,
    middleware: [rateLimit(createStandardApiRateLimitOptions())],
  },
);
