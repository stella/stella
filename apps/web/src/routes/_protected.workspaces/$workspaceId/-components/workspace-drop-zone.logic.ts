type ResolveWorkspaceDropUploadParentIdInput = {
  activeViewLayoutType: string | null | undefined;
  currentFolderId: string | null | undefined;
};

export const resolveWorkspaceDropUploadParentId = ({
  activeViewLayoutType,
  currentFolderId,
}: ResolveWorkspaceDropUploadParentIdInput): string | null => {
  if (activeViewLayoutType !== "filesystem") {
    return null;
  }

  return currentFolderId ?? null;
};
