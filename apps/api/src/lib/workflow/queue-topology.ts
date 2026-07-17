import type { AIRequestServiceTier } from "@/api/lib/ai-config";
import { LIMITS } from "@/api/lib/limits";

export const WORKFLOW_QUEUE_CLASS = {
  standard: "standard",
  flex: "flex",
} as const;

export type WorkflowQueueClass =
  (typeof WORKFLOW_QUEUE_CLASS)[keyof typeof WORKFLOW_QUEUE_CLASS];

export const WORKFLOW_QUEUE_NAMES = {
  [WORKFLOW_QUEUE_CLASS.standard]: "workflow",
  [WORKFLOW_QUEUE_CLASS.flex]: "workflow-flex",
} as const satisfies Record<WorkflowQueueClass, string>;

export const WORKFLOW_QUEUE_CLASSES = [
  WORKFLOW_QUEUE_CLASS.standard,
  WORKFLOW_QUEUE_CLASS.flex,
] as const satisfies readonly WorkflowQueueClass[];

// Rollout phase one only expands topology awareness. Keeping every producer on
// the legacy queue means an older replica can still drain all admitted jobs;
// deferred-tier routing changes only after this topology is deployed.
const WORKFLOW_QUEUE_CLASS_BY_SERVICE_TIER = {
  standard: WORKFLOW_QUEUE_CLASS.standard,
  flex: WORKFLOW_QUEUE_CLASS.standard,
  batch: WORKFLOW_QUEUE_CLASS.standard,
} as const satisfies Record<AIRequestServiceTier, WorkflowQueueClass>;

export const workflowQueueClassForServiceTier = (
  serviceTier: AIRequestServiceTier,
): WorkflowQueueClass => WORKFLOW_QUEUE_CLASS_BY_SERVICE_TIER[serviceTier];

export type WorkflowWorkerSpec = {
  queueClass: WorkflowQueueClass;
  concurrency: number;
};

export const WORKFLOW_WORKER_SPECS = [
  {
    queueClass: WORKFLOW_QUEUE_CLASS.standard,
    concurrency: LIMITS.workflowStandardWorkerConcurrency,
  },
  {
    queueClass: WORKFLOW_QUEUE_CLASS.flex,
    concurrency: LIMITS.workflowFlexWorkerConcurrency,
  },
] as const satisfies readonly WorkflowWorkerSpec[];

type WorkflowLiveJob = {
  data: {
    workspaceId: string;
  };
};

type LiveWorkflowWorkspaceSnapshot = {
  workspaceIds: Set<string>;
  truncated: boolean;
};

export const combineLiveWorkflowJobSnapshots = ({
  jobSnapshots,
  scanLimit,
}: {
  jobSnapshots: readonly (readonly WorkflowLiveJob[])[];
  scanLimit: number;
}): LiveWorkflowWorkspaceSnapshot => {
  const workspaceIds = new Set<string>();
  let truncated = false;

  for (const jobs of jobSnapshots) {
    if (jobs.length >= scanLimit) {
      truncated = true;
    }
    for (const job of jobs) {
      if (job.data.workspaceId.length > 0) {
        workspaceIds.add(job.data.workspaceId);
      }
    }
  }

  return { workspaceIds, truncated };
};
