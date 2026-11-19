import type { ComponentProps } from "react";

import { FilterIcon } from "../icons";
import { cn } from "../lib/utils";
import { Button } from "./button";

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
