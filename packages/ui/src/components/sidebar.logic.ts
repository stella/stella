export type SidebarState = "expanded" | "collapsed";

/**
 * A `SidebarMenuButton`'s tooltip repeats the label already visible in the
 * expanded rail, and mobile never collapses to icons, so it only earns its
 * keep on desktop while the sidebar is icon-collapsed.
 */
export const isSidebarMenuButtonTooltipVisible = ({
  state,
  isMobile,
}: {
  state: SidebarState;
  isMobile: boolean;
}): boolean => state === "collapsed" && !isMobile;

/**
 * The sidebar's displayed open state: the requested state (controlled prop,
 * or the uncontrolled fallback), masked by `forceCollapsed`. A host can force
 * the sidebar collapsed (e.g. a narrow viewport) without losing track of
 * what the user actually asked for.
 */
export const resolveSidebarOpen = ({
  requestedOpen,
  forceCollapsed,
}: {
  requestedOpen: boolean;
  forceCollapsed: boolean;
}): boolean => requestedOpen && !forceCollapsed;

/** The `data-state` driven off the sidebar's displayed open state. */
export const deriveSidebarState = (open: boolean): SidebarState =>
  open ? "expanded" : "collapsed";

/**
 * `toggleSidebar`'s desktop transition: it flips the *requested* open state,
 * not the *displayed* one. `forceCollapsed` can mask a `true` requested state
 * down to a collapsed display; toggling while forced-collapsed still records
 * the flip so it takes effect once `forceCollapsed` lifts.
 */
export const nextRequestedOpen = (requestedOpen: boolean): boolean =>
  !requestedOpen;

/** `toggleSidebar`'s mobile transition: it flips the sheet's open state. */
export const nextOpenMobile = (openMobile: boolean): boolean => !openMobile;
