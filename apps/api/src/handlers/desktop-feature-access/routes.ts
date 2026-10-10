import Elysia from "elysia";

import { DESKTOP_FEATURE_ACCESS_PATH } from "@stll/api-contract/desktop-feature-access";

import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import read from "./read";

export const desktopFeatureAccessRoute = new Elysia({
  prefix: DESKTOP_FEATURE_ACCESS_PATH,
})
  .use(rateLimit(createStandardApiRateLimitOptions()))
  .get("/", read.handler, { response: read.config.response });
