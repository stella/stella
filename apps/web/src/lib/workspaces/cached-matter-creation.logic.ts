import type { QueryClient } from "@tanstack/react-query";

import type { WorkspacesData } from "@/lib/workspaces/queries";
import { workspacesListsKey } from "@/lib/workspaces/workspaces-list-keys.logic";

// An active list's key is the lists root and the organization; a list of
// another status adds that status after it.
const ACTIVE_LIST_KEY_LENGTH = workspacesListsKey().length + 1;

/**
 * Whether the matters lists the cache already holds leave room for a new
 * matter, for a loading view that draws the "New matter" button only where
 * the loaded toolbar will. Nothing is fetched. Fails closed: no cached active
 * list, one whose last read failed, or any list at its limit reads as no
 * room (the cache can hold another organization's list after a switch, and
 * the view cannot tell which one is the member's).
 */
export const cachedMatterCreationOpen = (queryClient: QueryClient): boolean => {
  const activeLists = queryClient
    .getQueriesData<WorkspacesData>({ queryKey: workspacesListsKey() })
    .filter(([queryKey]) => queryKey.length === ACTIVE_LIST_KEY_LENGTH);
  return (
    activeLists.length > 0 &&
    activeLists.every(
      ([queryKey, data]) =>
        data !== undefined &&
        queryClient.getQueryState(queryKey)?.error === null &&
        data.creationCapacity.canCreate,
    )
  );
};
