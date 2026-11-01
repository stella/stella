import { flowRunUpdateRealtimeEvent } from "@stll/api-contract";

import type { SafeId } from "@/api/lib/branded-types";
import type {
  FlowRunStatus,
  FlowRunStepStatus,
} from "@/api/lib/flows/flow-types";
import { broadcast } from "@/api/lib/sse";

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
  broadcast(workspaceId, flowRunUpdateRealtimeEvent(payload));
};
