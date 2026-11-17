type InspectorDockVisibilityInput = {
  /** The saved layout opens the pane, while its tabs are still restoring. */
  reservePane: boolean;
  tabCount: number;
  minimized: boolean;
};

/**
 * Where the member's inspector shows. The desktop dock keeps its saved width
 * while tabs restore, so the page does not shift when they arrive; the mobile
 * sheet overlays the page, so it opens only on a real tab.
 */
export const resolveInspectorDockVisibility = ({
  reservePane,
  tabCount,
  minimized,
}: InspectorDockVisibilityInput) => {
  const hasOpenTab = tabCount > 0 && !minimized;
  return { dockOpen: reservePane || hasOpenTab, sheetOpen: hasOpenTab };
};
