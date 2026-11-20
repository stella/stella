import type { ComponentProps } from "react";

import { cn } from "../lib/utils";

/*
 * The view chrome's rows, apart from the controls that go in them: a loading
 * view drawn before the page mounts lays out the same row without loading a
 * button, and the controls that replace its faces land in the same boxes.
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
