/**
 * The dockable inspector pane: chrome, dock, and the width policy that keeps
 * the content column beside it usable.
 *
 * One module rather than one subpath per file, because the parts only make
 * sense together: the dock's width comes from the hook, the hook's clamp comes
 * from the width policy, and the chrome's row rhythm comes from the same
 * layout tokens the dock reserves space with.
 */

export {
  Inspector,
  InspectorActions,
  InspectorContent,
  InspectorDescription,
  InspectorEmptyRow,
  InspectorHeader,
  InspectorHeaderText,
  InspectorProperty,
  InspectorPropertyLabel,
  InspectorPropertyList,
  InspectorPropertyValue,
  InspectorRail,
  InspectorRailCell,
  InspectorRailContent,
  InspectorRailFooter,
  InspectorRailIconButton,
  InspectorRailTab,
  InspectorSection,
  InspectorSectionTitle,
  InspectorTitle,
} from "./chrome";
export { InspectorDock } from "./dock";
export {
  InspectorTab,
  InspectorTabList,
  InspectorTabPanel,
  InspectorTabs,
} from "./tabs";
export {
  PROPERTY_ROW_GRID,
  SIDE_RAIL_CONTAINER_CLASS,
  SIDE_RAIL_ICON_BUTTON_SIZE,
  SIDE_RAIL_TAB_ICON_SIZE,
  SIDE_RAIL_WIDTH,
  TOOLBAR_ROW_HEIGHT,
  TOOLBAR_ROW_HEIGHT_PX,
} from "./layout-tokens";
export {
  INSPECTOR_CONTENT_MIN_WIDTH,
  INSPECTOR_EDITOR_MIN_WIDTH,
  INSPECTOR_PANE_DEFAULT_WIDTH,
  INSPECTOR_PANE_MAX_WIDTH,
  INSPECTOR_PANE_MIN_WIDTH,
  INSPECTOR_RAIL_WIDTH,
  resolveInspectorDockWidth,
  resolveInspectorPaneMaxWidth,
  resolveInspectorPaneWidth,
  shouldForceSidebarCollapsed,
} from "./pane-width";
export {
  INSPECTOR_PANE_KEYBOARD_PAGE_STEP,
  INSPECTOR_PANE_KEYBOARD_STEP,
  parsePersistedPaneWidth,
  resolveDragWidth,
  resolveKeyboardWidth,
  useInspectorPaneWidth,
} from "./use-pane-width";
