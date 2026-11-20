import type { ComponentProps } from "react";

import { FilterIcon } from "../icons";
import { cn } from "../lib/utils";
import { Button } from "./button";
import {
  VIEW_FILTER_BUTTON,
  VIEW_FILTER_CHIP,
  VIEW_FILTER_ICON_CLASS_NAME,
} from "./view-toolbar-classes";

export { ViewChromeBar, ViewToolbarChrome } from "./view-toolbar-shell";

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
    size={VIEW_FILTER_BUTTON.size}
    title={label}
    variant={VIEW_FILTER_BUTTON.variant}
  >
    <FilterIcon className={VIEW_FILTER_ICON_CLASS_NAME} />
  </Button>
);

export const ViewFilterChip = ({
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "size" | "variant">) => (
  <Button
    {...props}
    className={cn(VIEW_FILTER_CHIP.className, className)}
    size={VIEW_FILTER_CHIP.size}
    variant={VIEW_FILTER_CHIP.variant}
  />
);
