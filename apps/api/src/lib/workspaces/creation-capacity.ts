import { LIMITS } from "@/api/lib/limits";

export const workspaceCreationCapacity = (workspaceCount: number) => ({
  canCreate: workspaceCount < LIMITS.workspacesCount,
  limit: LIMITS.workspacesCount,
});
