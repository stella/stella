import type { ReactNode } from "react";

import { cn } from "@stll/ui/utils";

type AIConfigModelRowProps = {
  label: string;
  compact?: boolean;
  children: ReactNode;
};

export const AIConfigModelRow = ({
  label,
  compact = false,
  children,
}: AIConfigModelRowProps) => (
  <div
    role="group"
    aria-label={label}
    className={cn(
      "grid border-t first:border-t-0 sm:items-center",
      compact
        ? "gap-2 p-2 sm:grid-cols-[7.5rem_8.5rem_minmax(0,1fr)]"
        : "gap-3 p-3 sm:grid-cols-[minmax(10rem,0.65fr)_minmax(11rem,0.75fr)_minmax(14rem,1.35fr)]",
    )}
  >
    <span className="min-w-0 text-sm font-medium">{label}</span>
    {children}
  </div>
);
