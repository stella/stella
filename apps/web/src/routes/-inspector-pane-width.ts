/**
 * App-local binding for the docked inspector pane's width policy.
 *
 * The arithmetic lives in `@stll/ui/inspector`, which takes the sidebar's
 * inline size as a parameter rather than importing it. This module supplies
 * this app's sidebar sizing, so call sites keep the one-argument shape they
 * had while the policy was route-private.
 */

import { shouldForceSidebarCollapsed as shouldForceSidebarCollapsedWithSidebar } from "@stll/ui/inspector";

import { SIDEBAR_WIDTH_PX } from "@/components/sidebar-sizing";

export {
  INSPECTOR_CONTENT_MIN_WIDTH,
  INSPECTOR_EDITOR_MIN_WIDTH,
  INSPECTOR_PANE_DEFAULT_WIDTH,
  INSPECTOR_PANE_MAX_WIDTH,
  INSPECTOR_PANE_MIN_WIDTH,
  resolveInspectorPaneMaxWidth,
  resolveInspectorPaneWidth,
} from "@stll/ui/inspector";

type ForceSidebarCollapsedInput = {
  inspectorPaneOpen: boolean;
  viewportWidth: number;
};

/**
 * The expanded sidebar yields its optional width before either docked pane
 * can violate its minimum. The collapsed rail plus both minimums fit at the
 * desktop breakpoint, so this policy keeps every desktop width usable.
 */
export const shouldForceSidebarCollapsed = ({
  inspectorPaneOpen,
  viewportWidth,
}: ForceSidebarCollapsedInput) =>
  shouldForceSidebarCollapsedWithSidebar({
    expandedSidebarWidth: SIDEBAR_WIDTH_PX,
    inspectorPaneOpen,
    viewportWidth,
  });
