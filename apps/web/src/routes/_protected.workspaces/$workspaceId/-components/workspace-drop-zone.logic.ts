import type { ViewLayoutType } from "@stll/api-contract";

type ResolveWorkspaceDropUploadParentIdInput = {
  activeViewId: string | undefined;
  currentFolderId: string | null | undefined;
  views: { id: string; layout: { type: ViewLayoutType } }[];
};

export const resolveWorkspaceDropUploadParentId = ({
  activeViewId,
  currentFolderId,
  views,
}: ResolveWorkspaceDropUploadParentIdInput): string | null => {
  const activeView = activeViewId
    ? views.find((view) => view.id === activeViewId)
    : undefined;
  if (activeView?.layout.type !== "filesystem") {
    return null;
  }

  return currentFolderId ?? null;
};

type UploadWorkspaceDropOptions<TInput> = {
  activeViewId: string | undefined;
  currentFolderId: string | null | undefined;
  input: TInput;
  loadViews: () => Promise<{ id: string; layout: { type: ViewLayoutType } }[]>;
  upload: (input: TInput & { parentId: string | null }) => void;
};

export const uploadWorkspaceDrop = async <TInput extends object>({
  activeViewId,
  currentFolderId,
  input,
  loadViews,
  upload,
}: UploadWorkspaceDropOptions<TInput>): Promise<void> => {
  const views = await loadViews();
  upload({
    ...input,
    parentId: resolveWorkspaceDropUploadParentId({
      activeViewId,
      currentFolderId,
      views,
    }),
  });
};
