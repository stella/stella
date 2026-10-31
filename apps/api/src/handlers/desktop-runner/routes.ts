import { routes } from "@/api/http/route";
import { DESKTOP_RUNNER_ROUTE_PREFIX } from "@/api/lib/desktop-runner/protocol";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import connect from "./connect";

export const desktopRunnerRoute = routes(
  { "/": { GET: connect } },
  {
    prefix: DESKTOP_RUNNER_ROUTE_PREFIX,
    middleware: [rateLimit(createStandardApiRateLimitOptions())],
  },
);
