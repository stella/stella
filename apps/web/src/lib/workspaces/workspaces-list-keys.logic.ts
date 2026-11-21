/**
 * The matters list's cache keys, apart from the rest of `workspacesKeys`
 * (./queries.logic.ts builds on these), so a loading view can read the list
 * the cache holds without importing the query layer.
 */
export const workspacesRootKey = () => ["workspaces"];

/** Every organization's matters lists (each status's). */
export const workspacesListsKey = () => [...workspacesRootKey(), "list"];

/** One organization's active matters list; another status adds itself. */
export const workspacesListKey = (activeOrganizationId: string) => [
  ...workspacesListsKey(),
  activeOrganizationId,
];
