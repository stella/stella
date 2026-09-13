/**
 * Where a docked inspector remembers how wide the reader dragged it.
 *
 * The width is a display preference of this browser, not workspace state, so
 * it is keyed by surface rather than by the organization and user the tab
 * state is scoped to (see `inspector-broadcast.ts`). A matter and the public
 * law surface put different things in the pane and are read at different
 * widths, so each keeps its own.
 */

export const INSPECTOR_PANE_SURFACES = ["matter", "public-law"] as const;

export type InspectorPaneSurface = (typeof INSPECTOR_PANE_SURFACES)[number];

const INSPECTOR_PANE_WIDTH_STORAGE_PREFIX = "stella:inspector-pane-width:v1";

export const inspectorPaneWidthStorageKey = (
  surface: InspectorPaneSurface,
): string => `${INSPECTOR_PANE_WIDTH_STORAGE_PREFIX}:${surface}`;
