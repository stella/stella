type VersionRefreshBoundary = {
  currentPathname: string;
  detectedPathname: string;
};

/**
 * A pathname change means TanStack Router accepted the navigation after any
 * route-owned unsaved-work blockers ran. Query and hash changes stay within
 * the current working surface and are not sufficient reload boundaries.
 */
export const shouldRefreshAfterNavigation = ({
  currentPathname,
  detectedPathname,
}: VersionRefreshBoundary): boolean => currentPathname !== detectedPathname;
