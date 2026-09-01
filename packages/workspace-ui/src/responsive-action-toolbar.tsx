import type * as React from "react";

import { cn } from "@stll/ui/utils";

export type ResponsiveActionToolbarSlot = "primary" | "secondary" | "action";

const RESPONSIVE_ACTION_TOOLBAR_SLOT_CLASS = {
  primary: "min-w-56 flex-1 shrink-0",
  secondary: "min-w-0 shrink-0",
  action: "shrink-0",
} as const satisfies Record<ResponsiveActionToolbarSlot, string>;

export const ResponsiveActionToolbar = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "flex min-w-0 scrollbar-none flex-nowrap items-center gap-2 overflow-x-auto [&::-webkit-scrollbar]:hidden",
      className,
    )}
    {...props}
  />
);

type ResponsiveActionToolbarItemProps = React.PropsWithChildren<{
  slot: ResponsiveActionToolbarSlot;
  className?: string | undefined;
}>;

export const ResponsiveActionToolbarItem = ({
  slot,
  className,
  children,
}: ResponsiveActionToolbarItemProps) => (
  <div className={cn(RESPONSIVE_ACTION_TOOLBAR_SLOT_CLASS[slot], className)}>
    {children}
  </div>
);
