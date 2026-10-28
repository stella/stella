import { DESKTOP_RUNNER_PATH } from "@stll/api-contract/desktop-runner";

import { routes } from "@/api/http/route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import connect from "./connect";

export const desktopRunnerRoute = routes(
  { "/": { GET: connect } },
  {
    prefix: DESKTOP_RUNNER_PATH,
    middleware: [rateLimit(createStandardApiRateLimitOptions())],
  },
);
