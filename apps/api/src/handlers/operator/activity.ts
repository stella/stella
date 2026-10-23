import { Result } from "better-result";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import { readOperatorActivitySummary } from "@/api/db/root";
import { env } from "@/api/env";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import type { OperatorActivitySummary } from "@/api/lib/db/operator-activity/read";

import { verifyOperatorCaller } from "./operator-caller";

export type OperatorActivityOptions = {
  configuredToken: () => string | undefined;
  readSummary: (now: number) => Promise<OperatorActivitySummary>;
  now?: () => number;
};

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "health_infra" },
  // The summary takes no parameters; any query is a caller mistake.
  query: v.strictObject({}),
} satisfies TokenHandlerConfig;

export const createOperatorActivity = ({
  configuredToken,
  readSummary,
  now = () => Temporal.Now.instant().epochMilliseconds,
}: OperatorActivityOptions) =>
  createSafeTokenHandler(
    config,
    verifyOperatorCaller({
      refusedEvent: "operator.activity.refused",
      configuredToken,
    }),
    async function* () {
      const summary = yield* Result.ok(await readSummary(now()));
      return Result.ok({
        generated_at: summary.generated_at,
        timezone: summary.timezone,
        weeks: summary.weeks.map((week) => ({
          week_start: week.week_start,
          partial: week.partial,
          active_orgs: week.active_orgs,
          signups: week.signups,
          activated_24h_pct: week.activated_24h_pct,
          weekly_retention_pct: week.weekly_retention_pct,
        })),
        same_point_last_week: {
          active_orgs: summary.same_point_last_week.active_orgs,
          signups: summary.same_point_last_week.signups,
        },
        unavailable_reasons: summary.unavailable_reasons,
      });
    },
  );

const operatorActivity = createOperatorActivity({
  configuredToken: () => env.OPERATOR_API_TOKEN,
  readSummary: readOperatorActivitySummary,
});

export default operatorActivity;
