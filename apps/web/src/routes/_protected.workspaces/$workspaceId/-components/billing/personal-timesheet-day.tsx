import { useMemo, useState } from "react";

import {
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { PencilIcon, PlusIcon, TrashIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/components/alert-dialog";
import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { stellaToast } from "@stll/ui/components/toast";

import { usePermissions } from "@/hooks/use-permissions";
import { detached } from "@/lib/detached";
import {
  timeEntriesInfiniteOptions,
  timeEntrySummaryOptions,
} from "@/lib/workspaces/queries/time-entries";
import { formatMinutes } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/format-duration";
import {
  ManualTimeEntryForm,
  type ManualTimeEntryValues,
} from "@/routes/_protected.workspaces/$workspaceId/-components/billing/manual-time-entry-form";
import {
  useCreateTimeEntry,
  useDeleteTimeEntry,
  useUpdateTimeEntry,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/time-entries";

type PersonalTimesheetDayProps = {
  workspaceId: string;
  date: string;
};

export const PersonalTimesheetDay = ({
  workspaceId,
  date,
}: PersonalTimesheetDayProps) => {
  const tBilling = useTranslations("billing");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const [dialog, setDialog] = useState<
    { type: "closed" } | { type: "create" } | { type: "edit"; id: string }
  >({ type: "closed" });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const canCreate = usePermissions({ timeEntry: ["create"] });
  const canUpdate = usePermissions({ timeEntry: ["update"] });
  const canDelete = usePermissions({ timeEntry: ["delete"] });
  const entriesQuery = useSuspenseInfiniteQuery(
    timeEntriesInfiniteOptions(workspaceId, {
      dateFrom: date,
      dateTo: date,
      scope: "me",
    }),
  );
  const { data: summary } = useSuspenseQuery(
    timeEntrySummaryOptions(workspaceId, date, date),
  );
  const entries = useMemo(
    () => entriesQuery.data.pages.flatMap((page) => page.items),
    [entriesQuery.data.pages],
  );
  const editingEntry =
    dialog.type === "edit"
      ? entries.find((entry) => entry.id === dialog.id)
      : undefined;

  const createEntry = useCreateTimeEntry();
  const updateEntry = useUpdateTimeEntry();
  const deleteEntry = useDeleteTimeEntry();

  const submit = async (values: ManualTimeEntryValues) => {
    try {
      if (dialog.type === "edit") {
        await updateEntry.mutateAsync({
          workspaceId,
          id: dialog.id,
          timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...values,
        });
      } else {
        await createEntry.mutateAsync({
          workspaceId,
          timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...values,
        });
      }
      setDialog({ type: "closed" });
    } catch {
      stellaToast.add({ title: tErrors("actionFailed"), type: "error" });
    }
  };

  const pending = createEntry.isPending || updateEntry.isPending;
  const deletingEntry = entries.find((entry) => entry.id === deletingId);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-3">
        <span className="text-sm font-medium tabular-nums">
          {formatMinutes(summary.totalMinutes)}
        </span>
        {canCreate && (
          <Button onClick={() => setDialog({ type: "create" })} size="sm">
            <PlusIcon className="size-4" />
            {tCommon("logTime")}
          </Button>
        )}
      </div>

      {entries.length > 0 ? (
        <div className="flex flex-col gap-2">
          {entries.map((entry) => (
            <div
              className="flex min-h-14 items-center gap-3 rounded-lg border px-3 py-2"
              key={entry.id}
            >
              <div className="min-w-0 flex-1">
                <BidiText as="p" className="truncate text-sm font-medium">
                  {entry.narrative}
                </BidiText>
                {!entry.billable && (
                  <span className="text-muted-foreground text-xs">
                    {tBilling("nonBillable")}
                  </span>
                )}
              </div>
              <span className="text-muted-foreground shrink-0 text-sm tabular-nums">
                {formatMinutes(entry.durationMinutes)}
              </span>
              {entry.status === "draft" && canUpdate && (
                <Button
                  aria-label={tCommon("edit")}
                  className="size-11"
                  onClick={() => setDialog({ type: "edit", id: entry.id })}
                  size="icon"
                  variant="ghost"
                >
                  <PencilIcon className="size-4" />
                </Button>
              )}
              {entry.status === "draft" && canDelete && (
                <Button
                  aria-label={tCommon("delete")}
                  className="text-destructive size-11"
                  disabled={deleteEntry.isPending}
                  onClick={() => setDeletingId(entry.id)}
                  size="icon"
                  variant="ghost"
                >
                  <TrashIcon className="size-4" />
                </Button>
              )}
            </div>
          ))}
          {entriesQuery.hasNextPage && (
            <Button
              disabled={entriesQuery.isFetchingNextPage}
              onClick={() => {
                detached(entriesQuery.fetchNextPage(), "PersonalTimesheetDay");
              }}
              variant="outline"
            >
              {tCommon("loadMore")}
            </Button>
          )}
        </div>
      ) : (
        <div className="text-muted-foreground flex flex-col items-center gap-3 rounded-lg border border-dashed py-10 text-center text-sm">
          <span>{tBilling("noEntries")}</span>
          {canCreate && (
            <Button
              onClick={() => setDialog({ type: "create" })}
              variant="outline"
            >
              {tCommon("logTime")}
            </Button>
          )}
        </div>
      )}

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setDialog({ type: "closed" });
          }
        }}
        open={dialog.type !== "closed"}
      >
        <DialogPopup className="max-w-lg">
          <DialogPanel className="flex flex-col gap-4">
            <DialogTitle>
              {dialog.type === "edit"
                ? tBilling("editEntry")
                : tCommon("logTime")}
            </DialogTitle>
            <ManualTimeEntryForm
              defaultValues={{
                dateWorked: editingEntry?.dateWorked ?? date,
                durationMinutes: editingEntry?.durationMinutes ?? 0,
                narrative: editingEntry?.narrative ?? "",
                billable: editingEntry?.billable ?? true,
              }}
              onCancel={() => setDialog({ type: "closed" })}
              onSubmit={submit}
              pending={pending}
              workspaceId={workspaceId}
            />
          </DialogPanel>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            setDeletingId(null);
          }
        }}
        open={deletingId !== null}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{tCommon("delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {tCommon("deleteConfirmDescription", {
                name: deletingEntry?.narrative ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>
              {tCommon("cancel")}
            </AlertDialogClose>
            <Button
              disabled={!deletingId || deleteEntry.isPending}
              onClick={() => {
                if (!deletingId) {
                  return;
                }
                detached(
                  deleteEntry
                    .mutateAsync({ workspaceId, id: deletingId })
                    .then(() => setDeletingId(null))
                    .catch(() => {
                      stellaToast.add({
                        title: tErrors("actionFailed"),
                        type: "error",
                      });
                    }),
                  "PersonalTimesheetDay",
                );
              }}
              variant="destructive"
            >
              {tCommon("delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
};
