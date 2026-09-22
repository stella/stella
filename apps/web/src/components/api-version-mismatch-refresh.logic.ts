type VersionRefreshBoundary = {
  currentPathname: string;
  detectedPathname: string;
  hasUnsavedWork: boolean;
};

/**
 * A pathname change means TanStack Router accepted the navigation after any
 * route-owned unsaved-work blockers ran. Query and hash changes stay within
 * the current working surface and are not sufficient reload boundaries.
 * Work that outlives the route (a chat draft) still defers the reload.
 */
export const shouldRefreshAfterNavigation = ({
  currentPathname,
  detectedPathname,
  hasUnsavedWork,
}: VersionRefreshBoundary): boolean =>
  currentPathname !== detectedPathname && !hasUnsavedWork;

type HiddenRefreshBoundary = {
  visibilityState: DocumentVisibilityState;
  hasUnsavedWork: boolean;
};

/**
 * A hidden tab with nothing unsaved can reload without the user seeing it or
 * losing work.
 */
export const shouldRefreshWhenHidden = ({
  visibilityState,
  hasUnsavedWork,
}: HiddenRefreshBoundary): boolean =>
  visibilityState === "hidden" && !hasUnsavedWork;
