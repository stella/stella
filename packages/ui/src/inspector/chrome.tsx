import type * as React from "react";

import { cn } from "../lib/utils";
import {
  PROPERTY_ROW_GRID,
  SIDE_RAIL_CONTAINER_CLASS,
  SIDE_RAIL_ICON_BUTTON_SIZE,
  TOOLBAR_ROW_HEIGHT,
} from "./layout-tokens";

/**
 * Inspector chrome: the shell, the icon rail, the header strip, and the
 * fixed-height key/value rows.
 *
 * The class strings are the workspace inspector's own, so an application
 * built on this package renders that component family rather than something
 * merely similar.
 *
 * Deliberately headless where a component library would otherwise leak: the
 * rail and the tab strip take rendered children, so the host picks its own
 * tabs primitive instead of inheriting one.
 *
 * Record-data slots (title, description, property value) hold caller-supplied
 * values such as case numbers, ECLI identifiers, and filenames. They isolate
 * their own bidi context so a Latin value inside an RTL inspector keeps its
 * character order and truncates from the correct end; chrome slots stay in
 * the surrounding direction. `dir` precedes the prop spread so callers can
 * force a direction. `chrome.test.tsx` pins which slots belong to each group.
 */

/** Outermost inspector surface. Fills the dock; owns no scrolling. */
export const Inspector = ({
  className,
  ...props
}: React.ComponentProps<"aside">) => (
  <aside
    className={cn(
      "bg-background text-foreground flex h-full min-h-0 w-full overflow-hidden shadow-lg",
      className,
    )}
    data-slot="inspector"
    {...props}
  />
);

/**
 * Vertical 48px icon rail. Hidden below the desktop breakpoint, where the
 * pane becomes a full-screen sheet and the rail's affordances move into
 * the header.
 */
export const InspectorRail = ({
  className,
  ...props
}: React.ComponentProps<"nav">) => (
  <nav
    className={cn(SIDE_RAIL_CONTAINER_CLASS, "hidden md:flex", className)}
    data-slot="inspector-rail"
    {...props}
  />
);

/** A rail cell: same height as every header strip and property row. */
export const InspectorRailCell = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "flex w-full shrink-0 items-center justify-center border-b",
      TOOLBAR_ROW_HEIGHT,
      className,
    )}
    data-slot="inspector-rail-cell"
    {...props}
  />
);

/** Scroll owner for rail tabs and other middle actions. */
export const InspectorRailContent = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "scrollbar-subtle flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain",
      className,
    )}
    data-slot="inspector-rail-content"
    {...props}
  />
);

/** Permanent inline-end action row, normally the new-chat affordance. */
export const InspectorRailFooter = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "flex w-full shrink-0 items-center justify-center border-t",
      TOOLBAR_ROW_HEIGHT,
      className,
    )}
    data-slot="inspector-rail-footer"
    {...props}
  />
);

export const InspectorRailIconButton = ({
  className,
  ...props
}: React.ComponentProps<"button">) => (
  <button
    className={cn(
      "text-muted-foreground hover:bg-accent hover:text-foreground flex items-center justify-center rounded-md outline-hidden transition-colors focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50",
      SIDE_RAIL_ICON_BUTTON_SIZE,
      className,
    )}
    data-slot="inspector-rail-icon-button"
    type="button"
    {...props}
  />
);

/**
 * A rail tab: one full-width row, bordered like every other rail cell, so
 * the stack reads as boxes in every dock. The active tab carries a 2px spine
 * on the rail's inline-start edge — the same affordance the workspace rail
 * uses to say "this pane is showing that tab".
 */
export const InspectorRailTab = ({
  active = false,
  className,
  ...props
}: React.ComponentProps<"button"> & { active?: boolean }) => (
  <button
    aria-current={active ? "true" : undefined}
    className={cn(
      "group/tab relative flex w-full shrink-0 items-center justify-center border-b transition-colors",
      TOOLBAR_ROW_HEIGHT,
      active
        ? "bg-background text-foreground before:bg-primary before:absolute before:inset-y-0 before:inset-s-0 before:w-0.5"
        : "text-muted-foreground hover:bg-accent hover:text-foreground",
      className,
    )}
    data-active={active ? "" : undefined}
    data-slot="inspector-rail-tab"
    type="button"
    {...props}
  />
);

/** Header strip. One row tall, bordered below, never scrolls. */
export const InspectorHeader = ({
  className,
  ...props
}: React.ComponentProps<"header">) => (
  <header
    className={cn(
      "flex shrink-0 items-center justify-between border-b px-3",
      TOOLBAR_ROW_HEIGHT,
      className,
    )}
    data-slot="inspector-header"
    {...props}
  />
);

export const InspectorHeaderText = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn("flex min-w-0 items-center gap-2 overflow-hidden", className)}
    data-slot="inspector-header-text"
    {...props}
  />
);

export const InspectorTitle = ({
  children,
  className,
  ...props
}: React.ComponentProps<"h2">) => (
  <h2
    className={cn(
      "truncate text-xs font-medium [unicode-bidi:isolate]",
      className,
    )}
    data-slot="inspector-title"
    dir="auto"
    {...props}
  >
    {children}
  </h2>
);

export const InspectorDescription = ({
  className,
  ...props
}: React.ComponentProps<"p">) => (
  <p
    className={cn(
      "text-muted-foreground truncate text-[11px] [unicode-bidi:isolate]",
      className,
    )}
    data-slot="inspector-description"
    dir="auto"
    {...props}
  />
);

export const InspectorActions = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn("flex shrink-0 items-center gap-1 ps-4", className)}
    data-slot="inspector-actions"
    {...props}
  />
);

/**
 * Scroll owner for the active tab. Exactly one of these is mounted at a
 * time: two nested scrollers inside a 512px pane is how a side panel stops
 * being navigable.
 */
export const InspectorContent = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "scrollbar-subtle flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain",
      className,
    )}
    data-slot="inspector-content"
    {...props}
  />
);

export const InspectorSection = ({
  className,
  ...props
}: React.ComponentProps<"section">) => (
  <section
    className={cn("shrink-0", className)}
    data-slot="inspector-section"
    {...props}
  />
);

/** Section header. Same row height as the properties beneath it. */
export const InspectorSectionTitle = ({
  children,
  className,
  ...props
}: React.ComponentProps<"h3">) => (
  <h3
    className={cn(
      "text-muted-foreground flex shrink-0 items-center border-b px-3 text-sm font-medium",
      TOOLBAR_ROW_HEIGHT,
      className,
    )}
    data-slot="inspector-section-title"
    {...props}
  >
    {children}
  </h3>
);

export const InspectorPropertyList = ({
  className,
  ...props
}: React.ComponentProps<"dl">) => (
  <dl
    className={cn("min-w-0", className)}
    data-slot="inspector-property-list"
    {...props}
  />
);

/**
 * A key/value row.
 *
 * The height is fixed, not a minimum. A row that grows to fit its value
 * breaks the rhythm the rail's cells set, and a column of rows at differing
 * heights stops reading as a scannable list — which is the whole point of
 * the layout. Long values truncate; the full text belongs in a tooltip or
 * an expanded view, not in a taller row.
 */
export const InspectorProperty = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "grid shrink-0 items-center gap-3 border-b px-3",
      PROPERTY_ROW_GRID,
      TOOLBAR_ROW_HEIGHT,
      className,
    )}
    data-slot="inspector-property"
    {...props}
  />
);

export const InspectorPropertyLabel = ({
  className,
  ...props
}: React.ComponentProps<"dt">) => (
  <dt
    className={cn(
      "text-muted-foreground min-w-0 truncate text-sm font-medium",
      className,
    )}
    data-slot="inspector-property-label"
    {...props}
  />
);

export const InspectorPropertyValue = ({
  className,
  ...props
}: React.ComponentProps<"dd">) => (
  <dd
    className={cn("min-w-0 truncate text-sm [unicode-bidi:isolate]", className)}
    data-slot="inspector-property-value"
    dir="auto"
    {...props}
  />
);

/** Row-height empty state, so an empty list keeps the list's rhythm. */
export const InspectorEmptyRow = ({
  className,
  ...props
}: React.ComponentProps<"p">) => (
  <p
    className={cn(
      "text-muted-foreground flex shrink-0 items-center border-b px-3 text-sm italic",
      TOOLBAR_ROW_HEIGHT,
      className,
    )}
    data-slot="inspector-empty-row"
    {...props}
  />
);
