import type { ReactNode } from "react";

import { Skeleton } from "@stll/ui/skeleton";

export const ExpenseRowFrame = ({
  children,
  trailingValue,
  actions,
}: {
  children: ReactNode;
  trailingValue: ReactNode;
  actions?: ReactNode;
}) => (
  <div className="group hover:bg-muted/50 flex items-center gap-3 rounded-md border px-3 py-2">
    {children}
    {trailingValue}
    {actions}
  </div>
);

export const ExpenseRowSkeleton = () => (
  <ExpenseRowFrame trailingValue={<Skeleton className="h-5 w-20 shrink-0" />}>
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <Skeleton className="h-5 w-40 max-w-1/2" />
        <Skeleton className="h-4 w-14 rounded-sm" />
        <Skeleton className="h-4 w-12 rounded-sm" />
      </div>
      <Skeleton className="h-4 w-56 max-w-full" />
    </div>
  </ExpenseRowFrame>
);

export const ExpenseListFrame = ({
  totals,
  actions,
  children,
}: {
  totals: ReactNode;
  actions: ReactNode;
  children: ReactNode;
}) => (
  <div className="flex flex-col gap-3">
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">{totals}</div>
      {actions}
    </div>
    {children}
  </div>
);
