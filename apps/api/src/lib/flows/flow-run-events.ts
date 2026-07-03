import type { SafeId } from "@/api/lib/branded-types";
import type {
  FlowRunStatus,
  FlowRunStepStatus,
} from "@/api/lib/flows/flow-types";
import { broadcast } from "@/api/lib/sse";

/**
 * Distinct SSE event type for flow run progress, keyed by workspace on the
 * existing workspace SSE channel (same mechanism the extraction engine uses,
 * but its own event type so the frontend can switch on it without colliding
 * with `invalidate-query` / `workflow-extraction-preview`).
 */
export const FLOW_RUN_UPDATE_EVENT_TYPE = "flow-run-update";

export type FlowRunUpdateStep = {
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
