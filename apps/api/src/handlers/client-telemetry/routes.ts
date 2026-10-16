import Elysia from "elysia";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import {
  actionSizeErrorResponse,
  boundActionRequest,
} from "@/api/lib/rate-limit/action-size-limits";
import type { RateLimitOptions } from "@/api/lib/rate-limit/contracts";
import { rateLimit } from "@/api/lib/rate-limit/rate-limit";
import { createRedisRateLimit } from "@/api/lib/rate-limit/redis-context";
import { createStandardApiRateLimitOptions } from "@/api/lib/rate-limit/standard-api";

import reportHang from "./report-hang";

export const WEB_HANG_REPORT_LIMIT = { max: 6, duration: 15 * 60_000 } as const;
export const WEB_HANG_REPORT_MAX_BYTES = 128;

export const createClientTelemetryRoute = (
  hangRateLimitOptions?: RateLimitOptions,
) => {
  const options =
    hangRateLimitOptions ??
    ({
      ...WEB_HANG_REPORT_LIMIT,
      budget: { name: "api.client_telemetry.address", keyKind: "address" },
      ...createRedisRateLimit({
        failurePolicy: "fail_open_local",
        scope: "client-telemetry",
      }),
    } as const satisfies RateLimitOptions);
  return new Elysia({
    prefix: `${STELLA_API_VERSION_PREFIX}/client-telemetry`,
    normalize: false,
  })
    .onRequest(async ({ request }) => {
      const bounded = await boundActionRequest(
        request,
        WEB_HANG_REPORT_MAX_BYTES,
      );
      if (bounded.isErr()) {
        return actionSizeErrorResponse(
          bounded.error,
          WEB_HANG_REPORT_MAX_BYTES,
        );
      }
      return undefined;
    })
    .use(rateLimit(createStandardApiRateLimitOptions()))
    .use(rateLimit(options))
    .post("/web-page-hang", reportHang.handler, {
      body: reportHang.config.body,
      response: reportHang.config.response,
    });
};

export const clientTelemetryRoute = createClientTelemetryRoute();
