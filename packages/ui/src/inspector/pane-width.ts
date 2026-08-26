/**
 * Width arithmetic for a docked inspector pane.
 *
 * The pane is a fixed overlay backed by an in-flow spacer, so nothing in
 * the layout pushes back when it grows: whatever the pane takes comes
 * straight out of the content column. Without a clamp against the space
 * actually available, shrinking the window (or expanding the sidebar)
 * leaves the content column a few dozen pixels wide instead of folding.
 *
 * The host application's sidebar width is a parameter rather than an
 * import, so the policy carries no coupling to any particular shell.
 */

export const INSPECTOR_PANE_DEFAULT_WIDTH = 512;
export const INSPECTOR_PANE_MIN_WIDTH = 320;

/**
 * Absolute ceiling, reached only on a very wide viewport. Past this the pane
 * is no longer a reading column, and the two documents it compares stop
 * being scannable side by side.
 */
export const INSPECTOR_PANE_MAX_WIDTH = 1400;

/**
 * Floor for the content column beside the pane. Below this the content
 * surface stops being usable, so the pane yields space first.
 */
export const INSPECTOR_CONTENT_MIN_WIDTH = 400;

/**
 * Comfortable measure for the document editor beside the pane, distinct from
 * {@link INSPECTOR_CONTENT_MIN_WIDTH}: that one is the hard floor any content
 * surface must keep (and the width the sidebar collapses to protect), this
 * one is the width a page of prose still reads at. The pane's *ceiling*
 * respects the readable measure; the hard floor still wins when the viewport
 * cannot give both.
 */
export const INSPECTOR_EDITOR_MIN_WIDTH = 560;

/** Inline size of the collapsed icon rail, in CSS pixels. */
export const INSPECTOR_RAIL_WIDTH = 48;

type ForceSidebarCollapsedInput = {
  /** Inline size the expanded sidebar takes out of the layout row. */
  expandedSidebarWidth: number;
  inspectorPaneOpen: boolean;
  /** Viewport width in CSS pixels; 0 before the viewport is known. */
  viewportWidth: number;
};

/**
 * The expanded sidebar yields its optional width before either docked pane
 * can violate its minimum. The collapsed rail plus both minimums fit at the
 * desktop breakpoint, so this policy keeps every desktop width usable.
 */
export const shouldForceSidebarCollapsed = ({
  expandedSidebarWidth,
  inspectorPaneOpen,
  viewportWidth,
}: ForceSidebarCollapsedInput) =>
  inspectorPaneOpen &&
  viewportWidth > 0 &&
  viewportWidth <
    expandedSidebarWidth +
      INSPECTOR_CONTENT_MIN_WIDTH +
      INSPECTOR_PANE_MIN_WIDTH;

type InspectorPaneWidthInput = {
  /** Width the user dragged the pane to. */
  desiredWidth: number;
  /** Inline size the sidebar takes out of the same layout row. */
  sidebarWidth: number;
  /** Viewport width in CSS pixels; 0 before the viewport is known. */
  viewportWidth: number;
};

/**
 * Largest width the pane may take without starving the content column.
 * Never returns less than {@link INSPECTOR_PANE_MIN_WIDTH}: a pane too
 * narrow to read is no better than a content column too narrow to read,
 * and collapsing the sidebar is the escape hatch for a genuinely small
 * viewport.
 */
export const resolveInspectorPaneMaxWidth = ({
  sidebarWidth,
  viewportWidth,
}: Omit<InspectorPaneWidthInput, "desiredWidth">) => {
  if (viewportWidth <= 0) {
    return INSPECTOR_PANE_MIN_WIDTH;
  }

  // Two ceilings, both binding. `readable` is viewport-relative and ignores
  // the sidebar, which yields its width before the pane has to (see
  // `shouldForceSidebarCollapsed`); `available` is what is actually left in
  // the row once the sidebar has taken its share.
  const readable = viewportWidth - INSPECTOR_EDITOR_MIN_WIDTH;
  const available = viewportWidth - sidebarWidth - INSPECTOR_CONTENT_MIN_WIDTH;
  return Math.max(
    INSPECTOR_PANE_MIN_WIDTH,
    Math.min(INSPECTOR_PANE_MAX_WIDTH, readable, available),
  );
};

/** Width the pane renders at, given the width the user asked for. */
export const resolveInspectorPaneWidth = ({
  desiredWidth,
  sidebarWidth,
  viewportWidth,
}: InspectorPaneWidthInput) =>
  Math.min(
    Math.max(desiredWidth, INSPECTOR_PANE_MIN_WIDTH),
    resolveInspectorPaneMaxWidth({ sidebarWidth, viewportWidth }),
  );

/**
 * Width the dock reserves in the layout: the full pane while content is
 * shown, the bare rail while it is collapsed or minimized.
 */
export const resolveInspectorDockWidth = ({
  paneWidth,
  showPaneContent,
}: {
  paneWidth: number;
  showPaneContent: boolean;
}) => (showPaneContent ? paneWidth : INSPECTOR_RAIL_WIDTH);
