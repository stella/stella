import type { ComponentProps } from "react";

import { FilterIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { Button } from "./button";

/** Shared view controls stay compact and scroll horizontally on small screens. */
export const ViewToolbarChrome = ({
  className,
  ...props
}: ComponentProps<"div">) => (
  <div
    className={cn(
      "flex min-w-0 shrink-0 [scrollbar-width:none] flex-nowrap items-center gap-1 overflow-x-auto px-2 py-1 [-ms-overflow-style:none] md:flex-wrap md:overflow-visible [&::-webkit-scrollbar]:hidden",
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
