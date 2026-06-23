import type * as React from "react";

import { cn } from "@stll/ui/lib/utils";

export type ResponsiveActionToolbarSlot = "primary" | "secondary" | "action";

const RESPONSIVE_ACTION_TOOLBAR_SLOT_CLASS = {
  primary:
    "order-1 min-w-0 basis-full sm:order-none sm:min-w-56 sm:basis-0 sm:flex-1",
  secondary: "order-2 min-w-0 flex-1 sm:order-none sm:flex-none",
  action: "order-3 shrink-0 sm:order-none",
} as const satisfies Record<ResponsiveActionToolbarSlot, string>;

export function ResponsiveActionToolbar({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-wrap items-center gap-2", className)}
      {...props}
    />
  );
}

type ResponsiveActionToolbarItemProps = React.PropsWithChildren<{
  slot: ResponsiveActionToolbarSlot;
  className?: string | undefined;
}>;

export function ResponsiveActionToolbarItem({
  slot,
  className,
  children,
}: ResponsiveActionToolbarItemProps) {
  return (
    <div className={cn(RESPONSIVE_ACTION_TOOLBAR_SLOT_CLASS[slot], className)}>
      {children}
    </div>
  );
}
