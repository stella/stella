import { PencilIcon, TrashIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { cn } from "@stella/ui/lib/utils";

import { usePermissions } from "@/hooks/use-permissions";
import { formatCurrencyAmount } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/format-currency";

type Expense = {
  id: string;
  matterId: string;
  dateIncurred: string;
  amount: number;
  currency: string;
  category: string;
  description: string;
  billable: boolean;
  markup: number;
  status: string;
  userName: string | null;
};

type ExpenseRowProps = {
  expense: Expense;
  matterName: string;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
};

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  approved: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  billed: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  written_off: "bg-red-500/10 text-red-700 dark:text-red-400",
};

export const ExpenseRow = ({
  expense,
  matterName,
  onEdit,
  onDelete,
}: ExpenseRowProps) => {
  const t = useTranslations();
  const canUpdateExpense = usePermissions({ expense: ["update"] });
  const canDeleteExpense = usePermissions({ expense: ["delete"] });

  return (
    <div className="group hover:bg-muted/50 flex items-center gap-3 rounded-md border px-3 py-2 transition-colors">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{matterName}</span>
          <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[0.625rem]">
            {
              {
                filing_fee: t("billing.expenses.categories.filing_fee"),
                expert_witness: t("billing.expenses.categories.expert_witness"),
                travel: t("billing.expenses.categories.travel"),
                printing: t("billing.expenses.categories.printing"),
                courier: t("billing.expenses.categories.courier"),
                other: t("billing.expenses.categories.other"),
              }[expense.category]
            }
          </span>
          {!expense.billable && (
            <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[0.625rem]">
              {t("billing.nonBillable")}
            </span>
          )}
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 text-[0.625rem]",
              STATUS_STYLES[expense.status] ?? STATUS_STYLES["draft"],
            )}
          >
            {
              {
                draft: t("billing.statuses.draft"),
                approved: t("billing.statuses.approved"),
                billed: t("billing.statuses.billed"),
                written_off: t("billing.statuses.written_off"),
              }[expense.status]
            }
          </span>
        </div>
        {expense.description && (
          <p className="text-muted-foreground truncate text-xs">
            {expense.description}
          </p>
        )}
      </div>

      <span className="shrink-0 text-sm tabular-nums">
        {formatCurrencyAmount(expense.amount, expense.currency)}
      </span>

      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {expense.status === "draft" && canUpdateExpense && (
          <Button
            className="size-7"
            onClick={() => onEdit(expense.id)}
            size="icon"
            variant="ghost"
          >
            <PencilIcon className="size-3.5" />
          </Button>
        )}
        {expense.status === "draft" && canDeleteExpense && (
          <Button
            className="text-destructive size-7"
            onClick={() => onDelete(expense.id)}
            size="icon"
            variant="ghost"
          >
            <TrashIcon className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
};
