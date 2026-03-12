import { useCallback, useMemo, useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Checkbox } from "@stella/ui/components/checkbox";
import { Dialog, DialogPopup } from "@stella/ui/components/dialog";
import { toastManager } from "@stella/ui/components/toast";

import { BatchActionBar } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/batch-action-bar";
import {
  formatDecimalHours,
  formatMinutes,
} from "@/routes/_protected.workspaces/$workspaceId/-components/billing/duration-input";
import {
  DEFAULT_CURRENCY,
  formatCurrencyAmount,
} from "@/routes/_protected.workspaces/$workspaceId/-components/billing/format-currency";
import { useMatterNameMap } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/matter-name-map";
import { TimeEntryForm } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/time-entry-form";
import type { TimeEntryFormValues } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/time-entry-form";
import { TimeEntryRow } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/time-entry-row";
import { TimerControls } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/timer-controls";
import {
  useCreateTimeEntry,
  useDeleteTimeEntry,
  useUpdateTimeEntry,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/time-entries";
import { timeEntriesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/time-entries";

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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const userId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.id,
  });

  const { data: entries } = useSuspenseQuery(
    timeEntriesOptions(workspaceId, {
      dateFrom: date,
      dateTo: date,
    }),
  );

  const matterNameMap = useMatterNameMap(workspaceId);

  const createEntry = useCreateTimeEntry();
  const updateEntry = useUpdateTimeEntry();
  const deleteEntry = useDeleteTimeEntry();

  const totalMinutes = useMemo(
    () => (entries ?? []).reduce((sum, e) => sum + e.durationMinutes, 0),
    [entries],
  );

  // Compute total billed amount
  const totalBilledAmount = useMemo(() => {
    if (entries === undefined) {
      return 0;
    }
    let total = 0;
    for (const e of entries) {
      if (e.billable) {
        total += Math.round((e.billedMinutes / 60) * e.rateAtEntry);
      }
    }
    return total;
  }, [entries]);

  // Find dominant currency for display
  const dominantCurrency = useMemo(() => {
    if (entries === undefined || entries.length === 0) {
      return DEFAULT_CURRENCY;
    }
    return entries.at(0)?.currency ?? DEFAULT_CURRENCY;
  }, [entries]);

  const editingEntry = editingId
    ? entries?.find((e) => e.id === editingId)
    : null;

  const handleCreate = (values: TimeEntryFormValues) => {
    createEntry.mutate(
      {
        workspaceId,
        matterId: values.matterId,
        dateWorked: values.dateWorked,
        timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
        durationMinutes: values.durationMinutes,
        rateAtEntry: values.rateAtEntry,
        currency: values.currency,
        narrative: values.narrative,
        billable: values.billable,
        taskCode: values.taskCode || null,
        activityCode: values.activityCode || null,
      },
      {
        onSuccess: () => setFormOpen(false),
        onError: () => {
          toastManager.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  const handleEdit = (values: TimeEntryFormValues) => {
    if (!editingId) {
      return;
    }
    updateEntry.mutate(
      {
        workspaceId,
        id: editingId,
        matterId: values.matterId,
        dateWorked: values.dateWorked,
        durationMinutes: values.durationMinutes,
        narrative: values.narrative,
        invoiceNarrative: values.invoiceNarrative || null,
        billable: values.billable,
        taskCode: values.taskCode || null,
        activityCode: values.activityCode || null,
        rateAtEntry: values.rateAtEntry,
        currency: values.currency,
      },
      {
        onSuccess: () => setEditingId(null),
        onError: () => {
          toastManager.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  const handleDelete = (id: string) => {
    deleteEntry.mutate(
      { workspaceId, id },
      {
        onError: () => {
          toastManager.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  const handleStatusChange = (id: string, status: "draft" | "approved") => {
    updateEntry.mutate(
      { workspaceId, id, status },
      {
        onError: () => {
          toastManager.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  const handleSelect = useCallback((id: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const handleSelectAll = () => {
    if (entries === undefined) {
      return;
    }
    if (selectedIds.size === entries.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(entries.map((e) => e.id)));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Timer */}
      <TimerControls workspaceId={workspaceId} />

      {/* Summary bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {entries !== undefined && entries.length > 0 && (
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
      {entries !== undefined && entries !== null && entries.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {entries.map((entry) => (
            <TimeEntryRow
              entry={entry}
              key={entry.id}
              matterName={
                matterNameMap.get(entry.matterId) ?? t("workspaces.defaultName")
              }
              onDelete={handleDelete}
              onEdit={setEditingId}
              onSelect={handleSelect}
              onStatusChange={handleStatusChange}
              selected={selectedIds.has(entry.id)}
              workspaceId={workspaceId}
            />
          ))}
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
                defaultValues={{
                  matterId: editingEntry.matterId,
                  dateWorked: editingEntry.dateWorked,
                  durationMinutes: editingEntry.durationMinutes,
                  narrative: editingEntry.narrative,
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
