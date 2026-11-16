export const matterMenuLifecycle = (isArchived: boolean, canUpdate: boolean) =>
  isArchived
    ? ({
        action: canUpdate ? "unarchive" : "none",
        editing: "read-only",
        deletion: "unarchive-first",
      } as const)
    : ({
        action: canUpdate ? "archive" : "none",
        editing: "editable",
        deletion: "allowed",
      } as const);
