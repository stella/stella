import { panic, Result } from "better-result";

import { Temporal } from "@stll/time";

import { readOperatorActivitySummary } from "@/api/db/root";
import { env } from "@/api/env";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { authorizeConfiguredBearer } from "@/api/lib/configured-bearer-access";
import { ACTIVITY_UNAVAILABLE_REASONS } from "@/api/lib/db/operator-activity/read";
import type { OperatorActivitySummary } from "@/api/lib/db/operator-activity/read";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";
import { permissiveRouteSchema } from "@/api/lib/permissive-route-schema";
import { applyResponseCachePolicy } from "@/api/lib/security-headers";

export type OperatorActivityOptions = {
  configuredToken: () => string | undefined;
  readSummary: (now: number) => Promise<OperatorActivitySummary>;
  now?: () => number;
};

const config = {
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "health_infra" },
  query: permissiveRouteSchema({ keys: [] }),
} satisfies TokenHandlerConfig;

export const createOperatorActivity = ({
  configuredToken,
  readSummary,
  now = () => Temporal.Now.instant().epochMilliseconds,
}: OperatorActivityOptions) =>
  createSafeTokenHandler(config, async function* ({ request, query, set }) {
    applyResponseCachePolicy({
      cache: { kind: "none" },
      response: undefined,
      set,
    });
    const access = authorizeConfiguredBearer({
      authorizationHeader: request.headers.get("authorization"),
      configuredToken: configuredToken(),
    });
    switch (access.status) {
      case "disabled":
        logger.info("operator.activity.refused", {
          "access.status": access.status,
        });
        return Result.err(
          new HandlerError({ status: 404, message: "Not available" }),
        );
      case "unauthorized":
        logger.info("operator.activity.refused", {
          "access.status": access.status,
        });
        return Result.err(
          new HandlerError({ status: 401, message: "Unauthorized" }),
        );
      case "authorized":
        break;
      default:
        access satisfies never;
        return panic("Unhandled operator access status");
    }
    if (Object.keys(query).length > 0) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Unexpected query parameters",
        }),
      );
    }
    const summary = yield* Result.ok(await readSummary(now()));
    return Result.ok({
      generated_at: summary.generated_at,
      sessions_active_5m: summary.sessions_active_5m,
      users_active_today: summary.users_active_today,
      signups_today: summary.signups_today,
      signups_7d: summary.signups_7d,
      chat_turns_1h: summary.chat_turns_1h,
      tool_calls_1h: summary.tool_calls_1h,
      unavailable_reasons: ACTIVITY_UNAVAILABLE_REASONS,
    });
  });

const operatorActivity = createOperatorActivity({
  configuredToken: () => env.OPERATOR_API_TOKEN,
  readSummary: readOperatorActivitySummary,
});

export default operatorActivity;
