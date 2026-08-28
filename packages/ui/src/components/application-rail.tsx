import type * as React from "react";

import { TOOLBAR_ROW_HEIGHT } from "../inspector/layout-tokens";
import { cn } from "../lib/utils";

export const APPLICATION_RAIL_WIDTH = "w-12" as const;
export const APPLICATION_RAIL_BUTTON_SIZE = "size-11" as const;
export const APPLICATION_RAIL_ICON_SIZE = "size-4" as const;

/**
 * A compact application navigation rail. It preserves the same desktop width,
 * button rhythm, separators, and account affordance as a collapsed app
 * sidebar without bringing sidebar expansion or mobile-sheet state into hosts
 * that only need a fixed rail.
 */
export const ApplicationRail = ({
  className,
  ...props
}: React.ComponentProps<"nav">) => (
  <nav
    className={cn(
      "bg-sidebar text-sidebar-foreground hidden h-full min-h-0 shrink-0 flex-col border-e md:flex",
      APPLICATION_RAIL_WIDTH,
      className,
    )}
    data-slot="application-rail"
    {...props}
  />
);

export const ApplicationRailHeader = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "flex shrink-0 items-center justify-center border-b p-0.5",
      TOOLBAR_ROW_HEIGHT,
      className,
    )}
    data-slot="application-rail-header"
    {...props}
  />
);

export const ApplicationRailContent = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "flex min-h-0 flex-1 [scrollbar-width:none] flex-col gap-2 overflow-x-hidden overflow-y-auto [&::-webkit-scrollbar]:hidden",
      className,
    )}
    data-slot="application-rail-content"
    {...props}
  />
);

export const ApplicationRailMenu = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn("flex flex-col gap-0.5 p-0.5", className)}
    data-slot="application-rail-menu"
    {...props}
  />
);

export const ApplicationRailButton = ({
  className,
  ...props
}: React.ComponentProps<"button">) => (
  <button
    className={cn(
      "text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground flex shrink-0 items-center justify-center rounded-md outline-hidden transition-colors focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50",
      APPLICATION_RAIL_BUTTON_SIZE,
      className,
    )}
    data-slot="application-rail-button"
    type="button"
    {...props}
  />
);

export const ApplicationRailSeparator = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn("bg-sidebar-border h-px shrink-0", className)}
    data-slot="application-rail-separator"
    role="separator"
    {...props}
  />
);

export const ApplicationRailFooter = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn("mt-auto flex shrink-0 flex-col gap-0.5 p-0.5", className)}
    data-slot="application-rail-footer"
    {...props}
  />
);
