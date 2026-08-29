export type FolioCollaborationMutationRevision = {
  document: number;
  local: number;
};

export const advanceFolioCollaborationMutationRevision = ({
  current,
  hasChanges,
  local,
}: {
  current: FolioCollaborationMutationRevision;
  hasChanges: boolean;
  local: boolean;
}): FolioCollaborationMutationRevision => {
  if (!hasChanges) {
    return current;
  }
  return {
    document: current.document + 1,
    local: current.local + (local ? 1 : 0),
  };
};
