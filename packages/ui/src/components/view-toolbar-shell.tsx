import type { ComponentProps, ReactNode } from "react";

import { FilterIcon } from "../icons";
import { cn } from "../lib/utils";
import { ButtonFace } from "./control-face";
import {
  VIEW_FILTER_BUTTON,
  VIEW_FILTER_CHIP,
  VIEW_FILTER_ICON_CLASS_NAME,
} from "./view-toolbar-classes";

/*
 * The view chrome's rows, apart from the controls that go in them: a loading
 * view drawn before the page mounts lays out the same row without loading a
 * button, and the controls that replace its faces land in the same boxes.
 * The faces of the filter controls (./view-toolbar.tsx) live here too.
 */

/**
 * The one row that holds a view switcher and its toolbar. It never wraps: at
 * any width the tabs and the controls share a single line, the tabs taking the
 * free space and scrolling, the toolbar keeping its place at the end.
 */
export const ViewChromeBar = ({
  className,
  ...props
}: ComponentProps<"div">) => (
  <div
    className={cn("flex min-w-0 flex-nowrap items-center border-b", className)}
    {...props}
  />
);

/**
 * Shared view controls, placed at the end of a `ViewChromeBar`. They stay on
 * one line and scroll horizontally once they outgrow half the row on a phone,
 * or two thirds of it from `md` up, so the tabs beside them always keep room
 * for a whole tab and scroll, and a control past the edge is scrolled to rather
 * than clipped.
 */
export const ViewToolbarChrome = ({
  className,
  ...props
}: ComponentProps<"div">) => (
  <div
    className={cn(
      "ms-auto flex max-w-1/2 min-w-0 shrink-0 [scrollbar-width:none] flex-nowrap items-center gap-1 overflow-x-auto px-2 py-1 [-ms-overflow-style:none] md:max-w-2/3 [&::-webkit-scrollbar]:hidden",
      className,
    )}
    {...props}
  />
);

/** The face of `ViewFilterButton` (./view-toolbar.tsx), for a loading view. */
export const ViewFilterButtonFace = () => (
  <ButtonFace
    size={VIEW_FILTER_BUTTON.size}
    variant={VIEW_FILTER_BUTTON.variant}
  >
    <FilterIcon className={VIEW_FILTER_ICON_CLASS_NAME} />
  </ButtonFace>
);

/**
 * The face of a `ViewFilterChip` (./view-toolbar.tsx), for a loading view:
 * the chip's box around what the caller draws of its content.
 */
export const ViewFilterChipFace = ({ children }: { children: ReactNode }) => (
  <ButtonFace
    className={VIEW_FILTER_CHIP.className}
    size={VIEW_FILTER_CHIP.size}
    variant={VIEW_FILTER_CHIP.variant}
  >
    {children}
  </ButtonFace>
);
