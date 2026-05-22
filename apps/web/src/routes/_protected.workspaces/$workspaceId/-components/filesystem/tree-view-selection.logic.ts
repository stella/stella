export type FolderClickIntent =
  | { type: "clear-and-navigate" }
  | { type: "clear-and-toggle" }
  | { type: "toggle-selection" };

type GetFolderClickIntentOptions = {
  currentFolderId: string | undefined;
  hasModifier: boolean;
};

export const getFolderClickIntent = ({
  currentFolderId,
  hasModifier,
}: GetFolderClickIntentOptions): FolderClickIntent => {
  if (hasModifier) {
    return { type: "toggle-selection" };
  }

  if (currentFolderId) {
    return { type: "clear-and-navigate" };
  }

  return { type: "clear-and-toggle" };
};
