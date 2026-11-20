import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";

import { WeekNavigatorFrame } from "@/components/billing/week-navigator.pending";
import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

import {
  ExpenseListFrame,
  ExpenseRowSkeleton,
} from "./-components/billing/expense-row.pending";

export const ExpensesShell = ({
  navigator,
  children,
}: {
  navigator: ReactNode;
  children: ReactNode;
}) => (
  <div className="flex h-full flex-col">
    <header className="flex items-center justify-between border-b px-4 py-3">
      <h1 className="text-sm font-medium">
        <PendingText id="common.expenses" />
      </h1>
      {navigator}
    </header>
    <ScrollArea className="flex-1">
      <div className="p-4">{children}</div>
    </ScrollArea>
  </div>
);

const EXPENSE_ROW_KEYS = ["a", "b", "c", "d", "e", "f"];

export const ExpenseListSkeleton = () => (
  <ExpenseListFrame
    actions={
      <ButtonFace size="sm" variant="outline">
        <PlusIcon className="size-4" />
        <PendingText id="billing.addEntry" />
      </ButtonFace>
    }
    totals={<Skeleton className="h-5 w-32" />}
  >
    <div className="flex flex-col gap-1.5">
      {EXPENSE_ROW_KEYS.map((key) => (
        <ExpenseRowSkeleton key={key} />
      ))}
    </div>
  </ExpenseListFrame>
);

const ExpenseWeekNavigatorPending = () => (
  <WeekNavigatorFrame
    today={
      <ButtonFace size="sm" variant="outline">
        <PendingText barClassName="w-9" id="common.today" />
      </ButtonFace>
    }
    previous={
      <ButtonFace className="size-7" size="icon" variant="ghost">
        <DirectionalIcon className="size-4" icon={ChevronLeftIcon} />
      </ButtonFace>
    }
    range={<FaceLabelPending className="w-32" />}
    next={
      <ButtonFace className="size-7" size="icon" variant="ghost">
        <DirectionalIcon className="size-4" icon={ChevronRightIcon} />
      </ButtonFace>
    }
  />
);

export const ExpensesPending = framePendingView(() => (
  <ExpensesShell navigator={<ExpenseWeekNavigatorPending />}>
    <ExpenseListSkeleton />
  </ExpensesShell>
));
