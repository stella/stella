import { Result } from "better-result";
import { t } from "elysia";

import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { emitWebPageHangSuspectedMetric } from "@/api/lib/observability/request-metrics";

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "health_infra" },
  cache: { kind: "none" },
  body: t.Object(
    { phase: t.Union([t.Literal("boot"), t.Literal("session")]) },
    { additionalProperties: false },
  ),
  response: safePublicHandlerResponseSchemasWithStatusText(
    t.Object({ accepted: t.Literal(true) }, { additionalProperties: false }),
  ),
} satisfies PublicHandlerConfig;

// Public, aggregate telemetry has no tenant data or caller identity to authorize.
export default createSafeBoundedPublicHandler(
  config,
  async function* ({ body }) {
    yield* Result.ok(emitWebPageHangSuspectedMetric(body.phase));
    return Result.ok({ accepted: true as const });
  },
);
