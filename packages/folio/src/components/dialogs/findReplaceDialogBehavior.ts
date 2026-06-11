export type FindDialogOpenBehavior =
  | {
      type: "open";
      searchText: string;
      shouldFindInitialText: boolean;
    }
  | {
      type: "closed";
      shouldClearHighlights: true;
    };

export const getFindDialogOpenBehavior = ({
  isOpen,
  initialSearchText,
}: {
  isOpen: boolean;
  initialSearchText: string;
}): FindDialogOpenBehavior => {
  if (!isOpen) {
    return { type: "closed", shouldClearHighlights: true };
  }

  return {
    type: "open",
    searchText: initialSearchText,
    shouldFindInitialText: initialSearchText.length > 0,
  };
};

export const shouldRefreshFindDialogSearch = ({
  isOpen,
  searchText,
}: {
  isOpen: boolean;
  searchText: string;
}): boolean => isOpen && searchText.trim().length > 0;
