import { DESKTOP_FEATURE_ACCESS_PATH } from "@stll/api-contract/desktop-feature-access";

import { routes } from "@/api/http/route";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import read from "./read";

export const desktopFeatureAccessRoute = routes(
  {
    "/": { GET: read },
  },
  {
    prefix: DESKTOP_FEATURE_ACCESS_PATH,
    middleware: [rateLimit(createStandardApiRateLimitOptions())],
  },
);
