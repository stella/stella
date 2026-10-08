import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { REALTIME_EVENT_TYPE } from "@stll/api-contract";

import type { rootDb } from "@/api/db/root";
import { featureEnrolments } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { backgroundFeatureActorExists } from "@/api/lib/feature-access/background";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import type {
  FlowRunStatus,
  FlowRunStepStatus,
} from "@/api/lib/flows/flow-types";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { broadcast } from "@/api/lib/sse";
import type { SseConnectionAuthorizers } from "@/api/lib/sse";

/**
 * Distinct SSE event type for flow run progress, keyed by workspace on the
 * existing workspace SSE channel (same mechanism the extraction engine uses,
 * but its own event type so the frontend can switch on it without colliding
 * with semantic resource events or `workflow-extraction-preview`).
 */
const FLOW_RUN_UPDATE_EVENT_TYPE = REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE;

type DeliverFlowRunWorkspaceEventOptions = Parameters<
  SseConnectionAuthorizers["workspaceEvent"]
>[0] & {
  database: Pick<typeof rootDb, "transaction">;
};

const recipientEnrolments = alias(
  featureEnrolments,
  "flow_sse_recipient_enrolments",
);

/** Keep other workspace events live while flow progress requires current recipient admission. */
export const deliverFlowRunWorkspaceEvent = async ({
  database,
  organizationId,
  workspaceId,
  userIds,
  event,
  deliver,
}: DeliverFlowRunWorkspaceEventOptions): Promise<void> => {
  if (event.type !== FLOW_RUN_UPDATE_EVENT_TYPE) {
    deliver(new Set(userIds));
    return;
  }
  if (!isDeploymentFeatureEnabled("FEATURE_FLOWS") || userIds.length === 0) {
    return;
  }
  await database.transaction(async (tx) => {
    await lockFeatureRecoveryAdmission({
      tx,
      organizationId,
      featureId: "flows",
    });
    if (!isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
      return;
    }
    const recipients = await tx
      .select({ userId: recipientEnrolments.userId })
      .from(recipientEnrolments)
      .where(
        and(
          eq(recipientEnrolments.organizationId, organizationId),
          eq(recipientEnrolments.featureId, "flows"),
          inArray(recipientEnrolments.userId, userIds),
          backgroundFeatureActorExists({
            organizationId,
            workspaceId,
            featureId: "flows",
            userId: recipientEnrolments.userId,
          }),
        ),
      );
    // Enqueue synchronously before releasing the same lock used by grant revocation.
    deliver(
      new Set(
        recipients.map((recipient) => brandPersistedUserId(recipient.userId)),
      ),
    );
  });
};

type FlowRunUpdateStep = {
  index: number;
  status: FlowRunStepStatus;
};

export type FlowRunUpdatePayload = {
  runId: SafeId<"flowRun">;
  status: FlowRunStatus;
  currentStepIndex: number;
  steps: FlowRunUpdateStep[];
};

/** Push one flow-run progress snapshot to the run's workspace subscribers. */
export const broadcastFlowRunUpdate = (
  workspaceId: SafeId<"workspace">,
  payload: FlowRunUpdatePayload,
): void => {
  broadcast(workspaceId, {
    type: FLOW_RUN_UPDATE_EVENT_TYPE,
    data: payload,
  });
};
