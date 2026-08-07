/**
 * Width arithmetic for the docked inspector pane.
 *
 * The pane is a fixed overlay backed by an in-flow spacer, so nothing in
 * the layout pushes back when it grows: whatever the pane takes comes
 * straight out of the content column. Without a clamp against the space
 * actually available, shrinking the window (or expanding the sidebar)
 * leaves the content column a few dozen pixels wide instead of folding.
 */

export const INSPECTOR_PANE_DEFAULT_WIDTH = 512;
export const INSPECTOR_PANE_MIN_WIDTH = 320;
export const INSPECTOR_PANE_MAX_WIDTH = 800;
/**
 * Floor for the content column beside the pane. Below this the chat
 * composer and the landing columns stop being usable, so the pane yields
 * space first.
 */
export const INSPECTOR_CONTENT_MIN_WIDTH = 400;

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
}: Omit<InspectorPaneWidthInput, "desiredWidth">): number => {
  if (viewportWidth <= 0) {
    return INSPECTOR_PANE_MIN_WIDTH;
  }

  const available = viewportWidth - sidebarWidth - INSPECTOR_CONTENT_MIN_WIDTH;
  return Math.max(
    INSPECTOR_PANE_MIN_WIDTH,
    Math.min(INSPECTOR_PANE_MAX_WIDTH, available),
  );
};

/** Width the pane renders at, given the width the user asked for. */
export const resolveInspectorPaneWidth = ({
  desiredWidth,
  sidebarWidth,
  viewportWidth,
}: InspectorPaneWidthInput): number =>
  Math.min(
    Math.max(desiredWidth, INSPECTOR_PANE_MIN_WIDTH),
    resolveInspectorPaneMaxWidth({ sidebarWidth, viewportWidth }),
  );
