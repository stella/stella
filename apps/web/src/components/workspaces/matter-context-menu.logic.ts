export const matterMenuLifecycle = (isArchived: boolean) =>
  isArchived
    ? ({
        action: "unarchive",
        editing: "read-only",
        deletion: "unarchive-first",
      } as const)
    : ({
        action: "archive",
        editing: "editable",
        deletion: "allowed",
      } as const);
