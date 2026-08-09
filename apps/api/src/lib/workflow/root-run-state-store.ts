import { createRedisClient } from "@/api/lib/redis-client";
import { createWorkflowRunStateStore } from "@/api/lib/workflow/run-state-store";

let rootWorkflowRunStateStore: ReturnType<
  typeof createWorkflowRunStateStore
> | null = null;

export const getRootWorkflowRunStateStore = () => {
  rootWorkflowRunStateStore ??=
    createWorkflowRunStateStore(createRedisClient());
  return rootWorkflowRunStateStore;
};
