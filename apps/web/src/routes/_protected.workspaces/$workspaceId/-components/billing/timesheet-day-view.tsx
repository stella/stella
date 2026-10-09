import { useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { timeEntryAmount } from "@stll/money";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { Dialog, DialogPopup } from "@stll/ui/dialog";
import { PlusIcon } from "@stll/ui/icons";

import {
  DEFAULT_CURRENCY,
  formatCurrencyAmount,
} from "@/components/billing/format-currency";
import { GlobalTimer } from "@/features/time-timers/global-timer";
import { notifyUserError } from "@/lib/errors/user-toast";
import {
  formatDecimalHours,
  formatMinutes,
} from "@/lib/workspaces/format-duration";
import {
  useCreateTimeEntry,
  useDeleteTimeEntry,
  useUpdateTimeEntry,
} from "@/lib/workspaces/mutations/time-entries";
import { timeEntriesOptions } from "@/lib/workspaces/queries/time-entries";
import { BatchActionBar } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/batch-action-bar";
import { useMatterNameMap } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/matter-name-map";
import { TimeEntryForm } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/time-entry-form";
import type { TimeEntryFormValues } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/time-entry-form";
import { TimeEntryRow } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/time-entry-row";

import { timeEntryContextUpdate } from "./time-entry-context.logic";

type TimesheetDayViewProps = {
  workspaceId: string;
  date: string;
};

export const TimesheetDayView = ({
  workspaceId,
  date,
}: TimesheetDayViewProps) => {
  const t = useTranslations();
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState(new Set<string>());

  const userId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.id,
  });

  const { data: entries } = useSuspenseQuery(
    timeEntriesOptions(workspaceId, userId, {
      dateFrom: date,
      dateTo: date,
    }),
  );

  const matterNameMap = useMatterNameMap(workspaceId);

  const createEntry = useCreateTimeEntry();
  const updateEntry = useUpdateTimeEntry();
  const deleteEntry = useDeleteTimeEntry();

  const totalMinutes = entries.reduce((sum, e) => sum + e.durationMinutes, 0);

  // Compute total billed amount
  const totalBilledAmount = (() => {
    let total = 0;
    for (const e of entries) {
      if (e.billable) {
        total += timeEntryAmount(e);
      }
    }
    return total;
  })();

  // Find dominant currency for display
  const dominantCurrency =
    entries.length === 0
      ? DEFAULT_CURRENCY
      : (entries.at(0)?.currency ?? DEFAULT_CURRENCY);

  const editingEntry = editingId
    ? entries.find((e) => e.id === editingId)
    : null;

  const handleCreate = (values: TimeEntryFormValues) => {
    createEntry.mutate(
      {
        workspaceId,
        workItemId: values.matterId,
        dateWorked: values.dateWorked,
        timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
        durationMinutes: values.durationMinutes,
        narrative: values.narrative,
        narrativeLanguage: values.narrativeLanguage,
        billable: values.billable,
        taskCode: values.taskCode || null,
        activityCode: values.activityCode || null,
      },
      {
        onSuccess: () => setFormOpen(false),
        onError: (error) => {
          notifyUserError(error, t("errors.actionFailed"));
        },
      },
    );
  };

  const handleEdit = (values: TimeEntryFormValues) => {
    if (!editingId || !editingEntry) {
      return;
    }
    updateEntry.mutate(
      {
        workspaceId,
        id: editingId,
        ...timeEntryContextUpdate(editingEntry, values.matterId),
        dateWorked: values.dateWorked,
        timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
        durationMinutes: values.durationMinutes,
        narrative: values.narrative,
        narrativeLanguage: values.narrativeLanguage,
        invoiceNarrative: values.invoiceNarrative || null,
        billable: values.billable,
        taskCode: values.taskCode || null,
        activityCode: values.activityCode || null,
      },
      {
        onSuccess: () => setEditingId(null),
        onError: (error) => {
          notifyUserError(error, t("errors.actionFailed"));
        },
      },
    );
  };

  const handleDelete = (id: string) => {
    deleteEntry.mutate(
      { workspaceId, id },
      {
        onError: (error) => {
          notifyUserError(error, t("errors.actionFailed"));
        },
      },
    );
  };

  const handleSelect = (id: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedIds.size === entries.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(entries.map((e) => e.id)));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Timer */}
      <GlobalTimer workspaceId={workspaceId} />

      {/* Summary bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {entries.length > 0 && (
            <Checkbox
              checked={
                selectedIds.size === entries.length && entries.length > 0
              }
              onCheckedChange={handleSelectAll}
            />
          )}
          <span className="text-sm font-medium tabular-nums">
            {formatMinutes(totalMinutes)}
          </span>
          <span className="text-muted-foreground text-xs tabular-nums">
            {t("billing.decimalHours", {
              hours: formatDecimalHours(totalMinutes),
            })}
          </span>
          {totalBilledAmount > 0 && (
            <span className="text-xs font-medium tabular-nums">
              {formatCurrencyAmount(totalBilledAmount, dominantCurrency)}
            </span>
          )}
        </div>
        <Button onClick={() => setFormOpen(true)} size="sm" variant="outline">
          <PlusIcon className="size-4" />
          {t("billing.addEntry")}
        </Button>
      </div>

      {/* Batch actions */}
      <BatchActionBar
        onClear={() => setSelectedIds(new Set())}
        selectedIds={[...selectedIds]}
        workspaceId={workspaceId}
      />

      {/* Entries list */}
      {entries.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {entries.map((entry) => {
            let matterName: string | undefined;
            if (entry.workItemReference?.type === "unavailable") {
              matterName = t("common.unavailable");
            } else if (entry.workItemId) {
              matterName = matterNameMap.get(entry.workItemId);
            }
            return (
              <TimeEntryRow
                entry={entry}
                key={entry.id}
                {...(matterName ? { matterName } : {})}
                onDelete={handleDelete}
                onEdit={setEditingId}
                onSelect={handleSelect}
                selected={selectedIds.has(entry.id)}
                workspaceId={workspaceId}
              />
            );
          })}
        </div>
      ) : (
        <div className="text-muted-foreground py-8 text-center text-sm">
          {t("billing.noEntries")}
        </div>
      )}

      {/* Create dialog */}
      <Dialog onOpenChange={setFormOpen} open={formOpen}>
        <DialogPopup className="max-w-md">
          <div className="p-4">
            <h3 className="mb-4 text-sm font-medium">
              {t("billing.addEntry")}
            </h3>
            <TimeEntryForm
              defaultValues={{ dateWorked: date }}
              onCancel={() => setFormOpen(false)}
              onSubmit={handleCreate}
              userId={userId}
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
            {editingEntry && (
              <TimeEntryForm
                contextState={
                  editingEntry.workItemReference?.type ?? "available"
                }
                defaultValues={{
                  matterId: editingEntry.workItemId ?? "",
                  dateWorked: editingEntry.dateWorked,
                  durationMinutes: editingEntry.durationMinutes,
                  narrative: editingEntry.narrative,
                  narrativeLanguage: editingEntry.narrativeLanguage,
                  invoiceNarrative: editingEntry.invoiceNarrative ?? "",
                  billable: editingEntry.billable,
                  taskCode: editingEntry.taskCode ?? "",
                  activityCode: editingEntry.activityCode ?? "",
                  rateAtEntry: editingEntry.rateAtEntry,
                  currency: editingEntry.currency,
                }}
                onCancel={() => setEditingId(null)}
                onSubmit={handleEdit}
                userId={userId}
                workspaceId={workspaceId}
              />
            )}
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  );
};
