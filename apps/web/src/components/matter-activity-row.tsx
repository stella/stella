import type * as React from "react";

import { cn } from "@stll/ui/utils";

import { SidebarMenuSubButton } from "@/components/sidebar";

type MatterActivityRowProps = {
  children: React.ReactElement;
  className?: string;
};

export const MatterActivityRow = ({
  children,
  className,
}: MatterActivityRowProps) => (
  <SidebarMenuSubButton asChild className={cn("w-full", className)} size="sm">
    {children}
  </SidebarMenuSubButton>
);
