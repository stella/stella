import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { REALTIME_EVENT_TYPE, RESOURCE_TYPE } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { featureEnrolments, flowRunSteps } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { backgroundFeatureActorExists } from "@/api/lib/feature-access/background";
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
  database: { transaction: ScopedDb<Pick<Transaction, "select" | "execute">> };
};

const recipientEnrolments = alias(
  featureEnrolments,
  "flow_sse_recipient_enrolments",
);

/** Progress and linked task identifiers require current recipient admission. */
export const deliverFlowRunWorkspaceEvent = async ({
  database,
  organizationId,
  workspaceId,
  userIds,
  event,
  deliver,
}: DeliverFlowRunWorkspaceEventOptions): Promise<void> => {
  if (userIds.length === 0) {
    return;
  }
  await withAggregateTransaction(database, async (tx) => {
    if (event.type !== FLOW_RUN_UPDATE_EVENT_TYPE) {
      const entityIds = [];
      switch (event.type) {
        case REALTIME_EVENT_TYPE.RESOURCE_UPDATED:
        case REALTIME_EVENT_TYPE.RESOURCE_DELETED:
          if (event.resource.type === RESOURCE_TYPE.ENTITY) {
            entityIds.push(event.resource.id);
          }
          break;
        case REALTIME_EVENT_TYPE.RESOURCES_CHANGED:
          for (const { resource } of event.changes) {
            if (resource.type === RESOURCE_TYPE.ENTITY) {
              entityIds.push(resource.id);
            }
          }
          break;
        default:
          break;
      }
      if (entityIds.length === 0) {
        deliver(new Set(userIds));
        return;
      }
      const linked = await tx
        .select({ id: flowRunSteps.id })
        .from(flowRunSteps)
        .where(
          and(
            eq(flowRunSteps.workspaceId, workspaceId),
            inArray(flowRunSteps.reviewTaskEntityId, entityIds),
          ),
        )
        .limit(1);
      if (linked.length === 0) {
        deliver(new Set(userIds));
        return;
      }
    }
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
    // Delivery is a pure read: it uses current admission without blocking grant changes.
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
