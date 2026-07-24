import type { AccessibleWorkspace } from "@/api/lib/auth";

type FilterUsableMcpWorkspacesInput = {
  accessibleWorkspaces: readonly AccessibleWorkspace[];
  /** Optional token attenuation; absent preserves the user's full live scope. */
  tokenWorkspaceIds: readonly string[] | undefined;
};

/**
 * Intersect a token's workspace attenuation with the user's current live
 * access. A signed claim can only narrow authority; it can never restore a
 * deleted/revoked workspace or grant an ID absent from live authorization.
 */
export const filterUsableMcpWorkspaces = ({
  accessibleWorkspaces,
  tokenWorkspaceIds,
}: FilterUsableMcpWorkspacesInput): AccessibleWorkspace[] => {
  const tokenWorkspaceIdSet = tokenWorkspaceIds
    ? new Set(tokenWorkspaceIds)
    : null;
  return accessibleWorkspaces.filter(
    (workspace) =>
      workspace.status !== "deleting" &&
      (tokenWorkspaceIdSet === null || tokenWorkspaceIdSet.has(workspace.id)),
  );
};
