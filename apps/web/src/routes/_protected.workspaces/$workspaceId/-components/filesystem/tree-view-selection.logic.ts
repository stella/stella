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

/** Selected ids in visible (flattened tree) order, so a bulk open produces
 *  the same tab order as the table. Ids outside the visible order (rows in
 *  collapsed folders picked up by select-all) follow in selection order. */
export const orderSelectedIds = (
  selectedIds: ReadonlySet<string>,
  orderedEntityIds: readonly string[],
): string[] => {
  const ordered: string[] = [];
  for (const id of orderedEntityIds) {
    if (selectedIds.has(id)) {
      ordered.push(id);
    }
  }
  const listed = new Set(ordered);
  for (const id of selectedIds) {
    if (!listed.has(id)) {
      ordered.push(id);
    }
  }
  return ordered;
};
