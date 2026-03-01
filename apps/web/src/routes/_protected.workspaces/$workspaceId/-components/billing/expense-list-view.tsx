import { useMemo, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Dialog, DialogPopup } from "@stella/ui/components/dialog";
import { toastManager } from "@stella/ui/components/toast";

import {
  ExpenseForm,
  type ExpenseFormValues,
} from "@/routes/_protected.workspaces/$workspaceId/-components/billing/expense-form";
import { ExpenseRow } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/expense-row";
import { useMatterNameMap } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/matter-name-map";
import {
  useCreateExpense,
  useDeleteExpense,
  useUpdateExpense,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/expenses";
import { expensesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/expenses";

const formatCurrencyAmount = (cents: number, currency: string): string => {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
};

type ExpenseListViewProps = {
  workspaceId: string;
  dateFrom: string;
  dateTo: string;
  matterId?: string;
};

export const ExpenseListView = ({
  workspaceId,
  dateFrom,
  dateTo,
  matterId,
}: ExpenseListViewProps) => {
  const t = useTranslations();
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const { data: expenses } = useSuspenseQuery(
    expensesOptions(workspaceId, {
      dateFrom,
      dateTo,
      ...(matterId ? { matterId } : {}),
    }),
  );

  const matterNameMap = useMatterNameMap(workspaceId);

  const createExpense = useCreateExpense();
  const updateExpense = useUpdateExpense();
  const deleteExpense = useDeleteExpense();

  const totalsByCurrency = useMemo(() => {
    if (!expenses || expenses.length === 0) {
      return [];
    }
    const map = new Map<string, number>();
    for (const e of expenses) {
      map.set(e.currency, (map.get(e.currency) ?? 0) + e.amount);
    }
    return Array.from(map, ([currency, amount]) => ({
      currency,
      amount,
    }));
  }, [expenses]);

  const editingExpense = editingId
    ? expenses?.find((e) => e.id === editingId)
    : null;

  const handleCreate = (values: ExpenseFormValues) => {
    createExpense.mutate(
      {
        workspaceId,
        matterId: values.matterId,
        dateIncurred: values.dateIncurred,
        timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
        amount: values.amount,
        currency: values.currency,
        category: values.category,
        description: values.description,
        billable: values.billable,
        markup: values.markup,
      },
      {
        onSuccess: () => setFormOpen(false),
        onError: () => {
          toastManager.add({
            title: t("billing.failedToSave"),
            type: "error",
          });
        },
      },
    );
  };

  const handleEdit = (values: ExpenseFormValues) => {
    if (!editingId) {
      return;
    }
    updateExpense.mutate(
      {
        workspaceId,
        id: editingId,
        matterId: values.matterId,
        dateIncurred: values.dateIncurred,
        amount: values.amount,
        currency: values.currency,
        category: values.category,
        description: values.description,
        billable: values.billable,
        markup: values.markup,
      },
      {
        onSuccess: () => setEditingId(null),
        onError: () => {
          toastManager.add({
            title: t("billing.failedToSave"),
            type: "error",
          });
        },
      },
    );
  };

  const handleDelete = (id: string) => {
    deleteExpense.mutate(
      { workspaceId, id },
      {
        onError: () => {
          toastManager.add({
            title: t("billing.failedToDelete"),
            type: "error",
          });
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Summary bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {totalsByCurrency.map(({ currency, amount }) => (
            <span className="text-sm font-medium tabular-nums" key={currency}>
              {`${t("billing.total")}: ${formatCurrencyAmount(
                amount,
                currency,
              )}`}
            </span>
          ))}
        </div>
        <Button onClick={() => setFormOpen(true)} size="sm" variant="outline">
          <PlusIcon className="size-4" />
          {t("billing.addEntry")}
        </Button>
      </div>

      {/* Expenses list */}
      {expenses && expenses.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {expenses.map((expense) => (
            <ExpenseRow
              expense={expense}
              key={expense.id}
              matterName={
                matterNameMap.get(expense.matterId) ??
                t("workspaces.defaultName")
              }
              onDelete={handleDelete}
              onEdit={setEditingId}
            />
          ))}
        </div>
      ) : (
        <div className="py-8 text-center text-sm text-muted-foreground">
          {t("billing.expenses.noExpenses")}
        </div>
      )}

      {/* Create dialog */}
      <Dialog onOpenChange={setFormOpen} open={formOpen}>
        <DialogPopup className="max-w-md">
          <div className="p-4">
            <h3 className="mb-4 text-sm font-medium">
              {t("billing.addEntry")}
            </h3>
            <ExpenseForm
              defaultValues={{ dateIncurred: dateFrom }}
              onCancel={() => setFormOpen(false)}
              onSubmit={handleCreate}
              workspaceId={workspaceId}
            />
          </div>
        </DialogPopup>
      </Dialog>

      {/* Edit dialog */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setEditingId(null);
          }
        }}
        open={editingId !== null}
      >
        <DialogPopup className="max-w-md">
          <div className="p-4">
            <h3 className="mb-4 text-sm font-medium">
              {t("billing.editEntry")}
            </h3>
            {editingExpense && (
              <ExpenseForm
                defaultValues={{
                  matterId: editingExpense.matterId,
                  dateIncurred: editingExpense.dateIncurred,
                  amount: editingExpense.amount,
                  currency: editingExpense.currency,
                  category: editingExpense.category,
                  description: editingExpense.description,
                  billable: editingExpense.billable,
                  markup: editingExpense.markup,
                }}
                onCancel={() => setEditingId(null)}
                onSubmit={handleEdit}
                workspaceId={workspaceId}
              />
            )}
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  );
};
