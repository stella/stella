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

type FileRowClickOptions = {
  /** `MouseEvent.detail`: 1 for the click that may begin a double-click. */
  clickCount: number;
  hasMeta: boolean;
  hasShift: boolean;
};

export type FileRowClickIntent =
  | {
      type: "select";
      meta: boolean;
      shift: boolean;
      /** Record the multi-row selection this click is about to collapse, so a
       *  `dblclick` still opens the set the user had. */
      snapshotSelection: boolean;
    }
  /** The closing click of a double-click: the opening one already ran the
   *  transition, so repeating it would toggle a sole selection back off. */
  | { type: "keep-selection" };

/** What a click on a file row does to the selection. The opening click of a
 *  double-click must still run its transition; suppressing it to protect the
 *  set the double-click opens leaves the selection uncollapsed and the range
 *  anchor stale, so a later shift-click extends from the wrong row. */
export const getFileRowClickIntent = ({
  clickCount,
  hasMeta,
  hasShift,
}: FileRowClickOptions): FileRowClickIntent => {
  if (clickCount > 1) {
    return { type: "keep-selection" };
  }
  return {
    type: "select",
    meta: hasMeta,
    shift: hasShift,
    // Only a plain click collapses the selection, so only it needs a snapshot.
    snapshotSelection: !hasMeta && !hasShift,
  };
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
