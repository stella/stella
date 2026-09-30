import { Suspense, useId, useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { Label } from "@stll/ui/label";
import { stellaToast } from "@stll/ui/toast";

import { QuickEntryRefusal } from "@/components/quick-entry-refusal";
import { emptyQuickEntryValues } from "@/components/quick-entry.logic";
import { MatterCombobox } from "@/components/workspaces/matter-combobox";
import type { MatterOption } from "@/components/workspaces/matter-combobox";
import { usePermissions } from "@/hooks/use-permissions";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { localISODate } from "@/lib/local-iso-date";
import { organizationSettingsOptions } from "@/lib/organization/settings-queries";
import { expensesQueryRoot } from "@/lib/resource-query-roots.logic";
import { useQuickEntryStore } from "@/lib/time/quick-entry-store";
import { myTimeEntriesKeys } from "@/lib/workspaces/queries/my-time-entries";
import { timeEntriesKeys } from "@/lib/workspaces/queries/time-entries";
import { ExpenseForm } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/expense-form";
import type { ExpenseFormValues } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/expense-form";
import { ManualTimeEntryForm } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/manual-time-entry-form";
import type { ManualTimeEntryValues } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/manual-time-entry-form";
import { useCreateExpense } from "@/routes/_protected.workspaces/$workspaceId/-mutations/expenses";
import { useCreateTimeEntry } from "@/routes/_protected.workspaces/$workspaceId/-mutations/time-entries";

type EntryStep =
  | { type: "time"; defaults: ManualTimeEntryValues; revision: number }
  | { type: "expense"; matter: MatterOption; date: string };
type SaveAction = "close" | "new" | "expense";

const QuickEntryDialog = () => {
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const closeDialog = useQuickEntryStore((state) => state.closeDialog);
  const canCreateExpense = usePermissions({ expense: ["create"] });
  const navigate = useNavigate();
  const client = useQueryClient();
  const { data: settings, error: settingsError } = useQuery(
    organizationSettingsOptions(user.activeOrganizationId),
  );
  const createTime = useCreateTimeEntry();
  const createExpense = useCreateExpense();
  const submitting = useRef(false);
  const matterId = useId();
  const [matter, setMatter] = useState<MatterOption | null>(null);
  const [step, setStep] = useState<EntryStep>({
    type: "time",
    defaults: emptyQuickEntryValues(localISODate()),
    revision: 0,
  });
  const [error, setError] = useState<unknown>(null);
  const pending = createTime.isPending || createExpense.isPending;

  const saveTime = async (
    values: ManualTimeEntryValues,
    action: SaveAction,
  ) => {
    if (matter === null || step.type !== "time" || submitting.current) {
      return;
    }
    submitting.current = true;
    setError(null);
    const result = await Result.tryPromise(() =>
      createTime.mutateAsync({
        ...values,
        workspaceId: matter.id,
        timezoneId: user.timezoneId,
      }),
    );
    submitting.current = false;
    if (Result.isError(result)) {
      setError(result.error);
      return;
    }
    detached(
      Promise.all([
        client.invalidateQueries({ queryKey: timeEntriesKeys.all(matter.id) }),
        client.invalidateQueries({
          queryKey: myTimeEntriesKeys.all(user.activeOrganizationId),
        }),
      ]),
      "quick-entry.invalidate-time",
    );
    stellaToast.add({
      type: "success",
      title: t("billing.quickEntry.entrySaved"),
      action: {
        label: t("billing.quickEntry.viewDay"),
        onClick: () =>
          detached(
            navigate({ to: "/time", search: { date: values.dateWorked } }),
            "quick-entry.open-day",
          ),
      },
    });
    switch (action) {
      case "close":
        closeDialog();
        return;
      case "new":
        setStep({
          type: "time",
          defaults: emptyQuickEntryValues(values.dateWorked),
          revision: step.revision + 1,
        });
        return;
      case "expense":
        setStep({ type: "expense", matter, date: values.dateWorked });
        return;
    }
  };

  const saveExpense = async (values: ExpenseFormValues) => {
    if (step.type !== "expense" || submitting.current) {
      return;
    }
    submitting.current = true;
    setError(null);
    const result = await Result.tryPromise(() =>
      createExpense.mutateAsync({
        ...values,
        workspaceId: step.matter.id,
        timezoneId: user.timezoneId,
      }),
    );
    submitting.current = false;
    if (Result.isError(result)) {
      setError(result.error);
      return;
    }
    detached(
      client.invalidateQueries({ queryKey: expensesQueryRoot(step.matter.id) }),
      "quick-entry.invalidate-expenses",
    );
    stellaToast.add({
      type: "success",
      title: t("billing.quickEntry.expenseSaved"),
    });
    closeDialog();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) {
          closeDialog();
        }
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t(
              step.type === "time"
                ? "common.logTime"
                : "billing.quickEntry.expenseTitle",
            )}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          {error !== null && <QuickEntryRefusal error={error} />}
          {settingsError !== null && (
            <QuickEntryRefusal error={settingsError} />
          )}
          {step.type === "time" ? (
            <>
              <fieldset disabled={pending} className="flex flex-col gap-1.5">
                <Label htmlFor={matterId}>{t("common.matter")}</Label>
                <MatterCombobox
                  activeOrganizationId={user.activeOrganizationId}
                  id={matterId}
                  order="recent"
                  onChange={(value) => {
                    setMatter(value);
                    setError(null);
                  }}
                  value={matter}
                />
              </fieldset>
              {settings !== undefined &&
                settings.timeMinimumUnitMinutes > 1 && (
                  <p className="text-muted-foreground text-sm">
                    {t("billing.quickEntry.minimumUnit")}
                  </p>
                )}
              {matter !== null && (
                <ManualTimeEntryForm
                  key={`${matter.id}:${step.revision}`}
                  workspaceId={matter.id}
                  defaultValues={step.defaults}
                  autofocusDuration
                  narrativeRequired={settings?.timeNarrativeRequired ?? false}
                  pending={pending}
                  onCancel={closeDialog}
                  onSubmit={(values) => saveTime(values, "close")}
                  onSaveAndNew={(values) => saveTime(values, "new")}
                  {...(canCreateExpense
                    ? {
                        onSaveAndAddExpense: (values: ManualTimeEntryValues) =>
                          saveTime(values, "expense"),
                      }
                    : {})}
                />
              )}
            </>
          ) : (
            <Suspense fallback={<p>{t("common.loading")}</p>}>
              <fieldset disabled={pending}>
                <ExpenseForm
                  workspaceId={step.matter.id}
                  defaultValues={{ dateIncurred: step.date }}
                  onSubmit={saveExpense}
                  onCancel={closeDialog}
                />
              </fieldset>
            </Suspense>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
};

export default QuickEntryDialog;
