import type { CSSProperties } from "react";

import { panic } from "better-result";

import { MATTER_TINT_GROUND, matterTint } from "@stll/ui/matter-colors";

/**
 * What the app sidebar paints. Each shell passes one explicitly; the fill is
 * computed here and set on the sidebar's own element, so it never depends on a
 * variable an ancestor may or may not define. A content-based tint is a new
 * member of this union, never a class a route passes in.
 */
export type AppSidebarSurface =
  { type: "untinted" } | { type: "matter"; color: string };

export const UNTINTED_APP_SIDEBAR_SURFACE = {
  type: "untinted",
} as const satisfies AppSidebarSurface;

/** The surface for a frame that may have a matter in scope. */
export const appSidebarSurfaceOf = (
  matterColor: string | null,
): AppSidebarSurface =>
  matterColor === null
    ? UNTINTED_APP_SIDEBAR_SURFACE
    : { type: "matter", color: matterColor };

const appSidebarFill = (surface: AppSidebarSurface): string => {
  switch (surface.type) {
    case "untinted":
      return MATTER_TINT_GROUND.chrome;
    case "matter":
      return matterTint(surface.color, MATTER_TINT_GROUND.chrome);
    default:
      surface satisfies never;
      return panic(`Unhandled app sidebar surface: ${String(surface)}`);
  }
};

type AppSidebarSurfaceProps = {
  className: string;
  style: CSSProperties & { "--app-sidebar-fill": string };
};

/**
 * The props that paint a sidebar's surface: the translucent veil and
 * backdrop blur shared with the chat composer tray, over the surface's fill.
 * The opaque-leaning fallback keeps contrast where backdrop-filter is
 * unsupported. The only place that styles the sidebar's inner panel.
 */
export const appSidebarSurfaceProps = (
  surface: AppSidebarSurface,
): AppSidebarSurfaceProps => ({
  className:
    "[&_[data-slot=sidebar-inner]]:bg-(--app-sidebar-fill)/80 [&_[data-slot=sidebar-inner]]:backdrop-blur-md supports-[backdrop-filter]:[&_[data-slot=sidebar-inner]]:bg-(--app-sidebar-fill)/60",
  style: { "--app-sidebar-fill": appSidebarFill(surface) },
});
