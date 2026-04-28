import type { useNavigate } from "@tanstack/react-router";

type Navigate = ReturnType<typeof useNavigate>;
const DEFAULT_WORKSPACE_VIEW_ID = "all";

export const getCurrentWorkspaceViewId = (
  pathname: string,
  workspaceId: string,
) => {
  const prefix = `/workspaces/${workspaceId}/`;
  if (!pathname.startsWith(prefix)) {
    return null;
  }

  const viewId = pathname.slice(prefix.length).split("/").at(0);
  return viewId || null;
};

export const getWorkspaceFolderNavigationTarget = ({
  folderId,
  pathname,
  targetWorkspaceId,
}: {
  folderId: string;
  pathname: string;
  targetWorkspaceId: string;
}) => {
  const viewId =
    getCurrentWorkspaceViewId(pathname, targetWorkspaceId) ??
    DEFAULT_WORKSPACE_VIEW_ID;

  return {
    to: "/workspaces/$workspaceId/$viewId" as const,
    params: { viewId, workspaceId: targetWorkspaceId },
    search: { folder: folderId },
  };
};

export const navigateToWorkspaceFolder = async ({
  folderId,
  navigate,
  pathname,
  targetWorkspaceId,
}: {
  folderId: string;
  navigate: Navigate;
  pathname: string;
  targetWorkspaceId: string;
}) => {
  await navigate(
    getWorkspaceFolderNavigationTarget({
      folderId,
      pathname,
      targetWorkspaceId,
    }),
  );
};
