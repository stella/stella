export const UNSCOPED_REQUEST = "__none__";

export type RequestWorkspacePolicy =
  | { type: "unscoped-allowed"; defaultWorkspaceId: null }
  | { type: "workspace-required"; defaultWorkspaceId: string | null };

type GetRequestWorkspacePolicyOptions = {
  canCreateUnscoped: boolean;
  workspaceIds: readonly string[];
};

export const getRequestWorkspacePolicy = ({
  canCreateUnscoped,
  workspaceIds,
}: GetRequestWorkspacePolicyOptions): RequestWorkspacePolicy => {
  if (canCreateUnscoped) {
    return { type: "unscoped-allowed", defaultWorkspaceId: null };
  }

  return {
    type: "workspace-required",
    defaultWorkspaceId: workspaceIds.at(0) ?? null,
  };
};
