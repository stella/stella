import { Result } from "better-result";

import { captureError } from "@/api/lib/analytics/capture";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import { incrementLaneCounter } from "@/api/lib/usage/lane-budget";
import { decisionUsageUnitsFromTokens } from "@/api/lib/usage/unit-model";
import { recordUsageEvent } from "@/api/lib/usage/usage-ledger";
import type { DecisionModel } from "@/api/lib/workflow/decisions/decision-model";

export type DecisionUsageMetering = AIUsageMetering & {
  /** One identity per provider call, retained across ledger transaction retries. */
  callId: string;
};

type RecordDecisionUsageOptions = {
  metering: DecisionUsageMetering;
  keySource: DecisionModel["keySource"];
  inputTokens: number;
};

export const recordDecisionUsage = async ({
  metering,
  keySource,
  inputTokens,
}: RecordDecisionUsageOptions): Promise<void> => {
  const isByok = keySource === "byok";
  const { rawUsageMicroUnits, unitsConsumed } = decisionUsageUnitsFromTokens({
    inputTokens,
    actionType: metering.actionType,
    isByok,
  });
  const lane = metering.lane ?? "pool";
  const result = await metering.safeDb(async (tx) => {
    const recorded = await recordUsageEvent({
      tx,
      organizationId: metering.organizationId,
      workspaceId: metering.workspaceId,
      userId: metering.userId,
      actionType: metering.actionType,
      modelRole: "decision",
      unitsConsumed: lane === "pool" ? unitsConsumed : 0,
      serviceTier: "standard",
      isByok,
      lane,
      rawUsageMicroUnits,
      traceId: metering.callId,
      idempotencyKey: `decision:${metering.callId}`,
    });
    if (recorded.status === "recorded" && lane !== "pool") {
      await incrementLaneCounter({
        tx,
        organizationId: metering.organizationId,
        userId: metering.userId,
        kind: lane === "fallback" ? "fallback_weekly" : "daily",
        microUnits: rawUsageMicroUnits,
      });
    }
    return recorded;
  });
  if (Result.isError(result)) {
    captureError(result.error, {
      source: "usage.decision",
      organization_id: metering.organizationId,
      trace_id: metering.callId,
    });
  }
};
