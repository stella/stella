import type { ComponentProps } from "react";

import { FilterIcon } from "../icons";
import { cn } from "../lib/utils";
import { Button } from "./button";

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

type ViewFilterButtonProps = Omit<
  ComponentProps<typeof Button>,
  "children" | "size" | "variant" | "aria-label" | "title"
> & {
  label: string;
};

export const ViewFilterButton = ({
  label,
  ...props
}: ViewFilterButtonProps) => (
  <Button
    {...props}
    aria-label={label}
    size="icon-xs"
    title={label}
    variant="ghost"
  >
    <FilterIcon className="size-3.5" />
  </Button>
);

export const ViewFilterChip = ({
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "size" | "variant">) => (
  <Button
    {...props}
    className={cn("gap-1.5 font-normal", className)}
    size="xs"
    variant="secondary"
  />
);
