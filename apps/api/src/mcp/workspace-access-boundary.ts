import type { SafeId } from "@/api/lib/branded-types";

type WorkspacePin = (workspaceId: SafeId<"workspace">) => boolean;

/**
 * Keep the set used to authorize RLS pins private. Callers receive a separate
 * set for ordinary access lookups, so mutating that public projection cannot
 * widen the IDs accepted by a bound pin callback.
 */
export const createWorkspaceAccessBoundary = (
  workspaceIds: readonly SafeId<"workspace">[],
) => {
  const pinnableWorkspaceIdSet = new Set<string>(workspaceIds);

  return {
    accessibleWorkspaceIdSet: new Set<string>(workspaceIds),
    bindWorkspacePin:
      (pinServerValidatedWorkspaceId: WorkspacePin): WorkspacePin =>
      (workspaceId) =>
        pinnableWorkspaceIdSet.has(workspaceId) &&
        pinServerValidatedWorkspaceId(workspaceId),
  };
};
