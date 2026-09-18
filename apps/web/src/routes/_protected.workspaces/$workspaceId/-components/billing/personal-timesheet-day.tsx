import { useMemo, useState } from "react";

import {
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { panic } from "better-result";
import { PencilIcon, PlusIcon, TrashIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { TimeEntrySuggestion } from "@stll/api-contract/time-entry-types";
import { Temporal } from "@stll/time";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Dialog, DialogPanel, DialogPopup, DialogTitle } from "@stll/ui/dialog";
import { stellaToast } from "@stll/ui/toast";

import { usePermissions } from "@/hooks/use-permissions";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import {
  timeEntriesInfiniteOptions,
  timeEntrySuggestionsOptions,
  timeEntrySummaryOptions,
} from "@/lib/workspaces/queries/time-entries";
import { formatMinutes } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/format-duration";
import {
  ManualTimeEntryForm,
  type ManualTimeEntryValues,
} from "@/routes/_protected.workspaces/$workspaceId/-components/billing/manual-time-entry-form";
import {
  timeEntryActionLabel,
  timeEntryNarrativeExcerpt,
} from "@/routes/_protected.workspaces/$workspaceId/-components/billing/time-entry-copy.logic";
import { TimeSuggestionsLane } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/time-suggestions-lane";
import {
  useCreateTimeEntry,
  useDecideTimeSuggestion,
  useDeleteTimeEntry,
  useUpdateTimeEntry,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/time-entries";

type PersonalTimesheetDayProps = {
  canCreateTimeEntry: boolean;
  workspaceId: string;
  date: string;
};

type DayDialog =
  | { type: "closed" }
  | { type: "create" }
  | { type: "edit"; id: string }
  | { type: "accept"; suggestion: TimeEntrySuggestion; narrative: string };

export const PersonalTimesheetDay = ({
  canCreateTimeEntry,
  workspaceId,
  date,
}: PersonalTimesheetDayProps) => {
  const tBilling = useTranslations("billing");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const timezoneId = Temporal.Now.timeZoneId();
  const [dialog, setDialog] = useState<DayDialog>({ type: "closed" });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busySuggestions, setBusySuggestions] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
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
  const { data: suggestions } = useSuspenseQuery(
    timeEntrySuggestionsOptions(workspaceId, date, timezoneId),
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
  const decideSuggestion = useDecideTimeSuggestion();

  const reportFailure = (error: unknown) => {
    getAnalytics().captureError(error);
    stellaToast.add({ title: tErrors("actionFailed"), type: "error" });
  };

  // Each in-flight decision stays disabled until its own request settles, so
  // a second click on the same row cannot send a duplicate accept.
  const markBusy = (fingerprint: string) =>
    setBusySuggestions((current) => new Set(current).add(fingerprint));
  const clearBusy = (fingerprint: string) =>
    setBusySuggestions((current) => {
      const next = new Set(current);
      next.delete(fingerprint);
      return next;
    });

  const acceptSuggestion = async (
    suggestion: TimeEntrySuggestion,
    values: Pick<
      ManualTimeEntryValues,
      "durationMinutes" | "narrative" | "billable"
    >,
  ) => {
    markBusy(suggestion.fingerprint);
    try {
      await decideSuggestion.mutateAsync({
        workspaceId,
        fingerprint: suggestion.fingerprint,
        date,
        timezoneId,
        decision: {
          type: "accept",
          durationMinutes: values.durationMinutes,
          narrative: values.narrative,
          billable: values.billable,
        },
      });
    } finally {
      clearBusy(suggestion.fingerprint);
    }
  };

  const dismissSuggestion = async (suggestion: TimeEntrySuggestion) => {
    markBusy(suggestion.fingerprint);
    try {
      await decideSuggestion.mutateAsync({
        workspaceId,
        fingerprint: suggestion.fingerprint,
        date,
        timezoneId,
        decision: { type: "dismiss" },
      });
    } finally {
      clearBusy(suggestion.fingerprint);
    }
  };

  const submit = async (values: ManualTimeEntryValues) => {
    try {
      if (dialog.type === "edit") {
        await updateEntry.mutateAsync({
          workspaceId,
          id: dialog.id,
          timezoneId,
          ...values,
        });
      } else if (dialog.type === "accept") {
        await acceptSuggestion(dialog.suggestion, values);
      } else {
        await createEntry.mutateAsync({
          workspaceId,
          timezoneId,
          ...values,
        });
      }
      setDialog({ type: "closed" });
    } catch (error) {
      reportFailure(error);
    }
  };

  const pending =
    createEntry.isPending ||
    updateEntry.isPending ||
    decideSuggestion.isPending;
  const deletingEntry = entries.find((entry) => entry.id === deletingId);
  const dialogTitle = (() => {
    switch (dialog.type) {
      case "edit":
        return tBilling("editEntry");
      case "accept":
        return tBilling("suggestions.title");
      case "create":
      case "closed":
        return tCommon("logTime");
      default:
        dialog satisfies never;
        return panic("Unhandled timesheet dialog state");
    }
  })();
  const formDefaults: ManualTimeEntryValues =
    dialog.type === "accept"
      ? {
          dateWorked: date,
          durationMinutes: dialog.suggestion.durationMinutes,
          narrative: dialog.narrative,
          billable: false,
        }
      : {
          dateWorked: editingEntry?.dateWorked ?? date,
          durationMinutes: editingEntry?.durationMinutes ?? 0,
          narrative: editingEntry?.narrative ?? "",
          billable: editingEntry?.billable ?? false,
        };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-3">
        <span className="text-sm font-medium tabular-nums">
          {formatMinutes(summary.totalMinutes)}
        </span>
        {canCreate && (
          <Button
            disabled={!canCreateTimeEntry}
            onClick={() => setDialog({ type: "create" })}
            size="sm"
          >
            <PlusIcon className="size-4" />
            {tCommon("logTime")}
          </Button>
        )}
      </div>

      {canCreate && canCreateTimeEntry && suggestions.items.length > 0 && (
        <TimeSuggestionsLane
          activeMinutes={suggestions.activeMinutes}
          busyFingerprints={busySuggestions}
          items={suggestions.items}
          loggedMinutes={summary.totalMinutes}
          onAccept={(suggestion, narrative) => {
            detached(
              acceptSuggestion(suggestion, {
                durationMinutes: suggestion.durationMinutes,
                narrative,
                billable: false,
              }).catch(reportFailure),
              "personal-timesheet-day.accept-suggestion",
            );
          }}
          onDismiss={(suggestion) => {
            detached(
              dismissSuggestion(suggestion).catch(reportFailure),
              "personal-timesheet-day.dismiss-suggestion",
            );
          }}
          onEdit={(suggestion, narrative) =>
            setDialog({ type: "accept", suggestion, narrative })
          }
        />
      )}

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
                {(!entry.billable || entry.source === "suggested") && (
                  <span className="text-muted-foreground text-xs">
                    {[
                      entry.source === "suggested"
                        ? tCommon("suggested")
                        : null,
                      entry.billable ? null : tBilling("nonBillable"),
                    ]
                      .filter((label) => label !== null)
                      .join(" · ")}
                  </span>
                )}
              </div>
              <span className="text-muted-foreground shrink-0 text-sm tabular-nums">
                {formatMinutes(entry.durationMinutes)}
              </span>
              {entry.status === "draft" &&
                entry.timerStartedAt === null &&
                canUpdate && (
                  <Button
                    aria-label={timeEntryActionLabel(
                      tCommon("edit"),
                      entry.narrative,
                    )}
                    className="size-11"
                    onClick={() => setDialog({ type: "edit", id: entry.id })}
                    size="icon"
                    variant="ghost"
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                )}
              {entry.status === "draft" &&
                entry.timerStartedAt === null &&
                canDelete && (
                  <Button
                    aria-label={timeEntryActionLabel(
                      tCommon("delete"),
                      entry.narrative,
                    )}
                    className="size-11"
                    disabled={deleteEntry.isPending}
                    onClick={() => setDeletingId(entry.id)}
                    size="icon"
                    variant="destructive-ghost"
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
                detached(
                  entriesQuery.fetchNextPage(),
                  "personal-timesheet-day.fetch-next-page",
                );
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
              disabled={!canCreateTimeEntry}
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
            <DialogTitle>{dialogTitle}</DialogTitle>
            <ManualTimeEntryForm
              dateLocked={dialog.type === "accept"}
              defaultValues={formDefaults}
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
                name: timeEntryNarrativeExcerpt(deletingEntry?.narrative ?? ""),
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
                    .catch((error: unknown) => {
                      reportFailure(error);
                    }),
                  "personal-timesheet-day.delete-entry",
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
