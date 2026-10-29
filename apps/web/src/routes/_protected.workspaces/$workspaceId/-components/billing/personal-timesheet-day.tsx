import { useMemo, useState } from "react";

import {
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { panic } from "better-result";
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
import { PencilIcon, PlusIcon, TrashIcon } from "@stll/ui/icons";
import { TimeEntryRow } from "@stll/ui/time-entry-row";

import {
  ManualTimeEntryForm,
  type ManualTimeEntryValues,
} from "@/components/billing/manual-time-entry-form";
import {
  timeEntryActionLabel,
  timeEntryNarrativeExcerpt,
} from "@/components/billing/time-entry-copy.logic";
import { usePermissions } from "@/hooks/use-permissions";
import { useSingleFlight } from "@/hooks/use-single-flight";
import type { ExceptionFingerprintKey } from "@/lib/analytics/exception-fingerprint";
import { getAnalytics } from "@/lib/analytics/provider";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import { formatMinutes } from "@/lib/workspaces/format-duration";
import {
  useCreateTimeEntry,
  useDecideTimeSuggestion,
  useDeleteTimeEntry,
  useUpdateTimeEntry,
} from "@/lib/workspaces/mutations/time-entries";
import {
  timeEntriesInfiniteOptions,
  timeEntrySuggestionsOptions,
  timeEntrySummaryOptions,
} from "@/lib/workspaces/queries/time-entries";
import { TimeSuggestionsLane } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/time-suggestions-lane";

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
  const userId = useAuthenticatedUser().id;
  const [dialog, setDialog] = useState<DayDialog>({ type: "closed" });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busySuggestions, setBusySuggestions] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const canCreate = usePermissions({ timeEntry: ["create"] });
  const canUpdate = usePermissions({ timeEntry: ["update"] });
  const canDelete = usePermissions({ timeEntry: ["delete"] });
  const entriesQuery = useSuspenseInfiniteQuery(
    timeEntriesInfiniteOptions(workspaceId, userId, {
      dateFrom: date,
      dateTo: date,
      scope: "me",
    }),
  );
  const { data: summary } = useSuspenseQuery(
    timeEntrySummaryOptions(workspaceId, userId, date, date),
  );
  const { data: suggestions } = useSuspenseQuery(
    timeEntrySuggestionsOptions(workspaceId, userId, date, timezoneId),
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
  const submitGuard = useSingleFlight();
  const updateEntry = useUpdateTimeEntry();
  const deleteEntry = useDeleteTimeEntry();
  const decideSuggestion = useDecideTimeSuggestion();

  const reportFailure = (
    error: unknown,
    fingerprintKey: ExceptionFingerprintKey,
  ) => {
    getAnalytics().captureError(error, {
      fingerprintKey,
      scope: { type: "handler", handlerId: fingerprintKey },
    });
    notifyUserError(error, tErrors("actionFailed"));
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
      "durationMinutes" | "narrative" | "narrativeLanguage" | "billable"
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
          narrativeLanguage: values.narrativeLanguage,
          // The value the form showed, even when it was the default, so a
          // rate change while the form is open cannot flip it.
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
      reportFailure(error, "PersonalTimesheetDay:submit");
    }
  };

  const submitOnce = async (values: Parameters<typeof submit>[0]) => {
    await submitGuard.run(async () => await submit(values));
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
          narrativeLanguage: null,
          billable: dialog.suggestion.billableByDefault,
        }
      : {
          dateWorked: editingEntry?.dateWorked ?? date,
          durationMinutes: editingEntry?.durationMinutes ?? 0,
          narrative: editingEntry?.narrative ?? "",
          narrativeLanguage: editingEntry?.narrativeLanguage ?? null,
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
          loggedMinutes={suggestions.loggedMinutes}
          onAccept={(suggestion, narrative) => {
            detached(
              acceptSuggestion(suggestion, {
                durationMinutes: suggestion.durationMinutes,
                narrative,
                narrativeLanguage: null,
                billable: suggestion.billableByDefault,
              }).catch((error: unknown) =>
                reportFailure(error, "PersonalTimesheetDay:accept-suggestion"),
              ),
              "personal-timesheet-day.accept-suggestion",
            );
          }}
          onDismiss={(suggestion) => {
            detached(
              dismissSuggestion(suggestion).catch((error: unknown) =>
                reportFailure(error, "PersonalTimesheetDay:dismiss-suggestion"),
              ),
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
            <TimeEntryRow
              key={entry.id}
              title={
                <BidiText as="span" className="truncate">
                  {entry.narrative}
                </BidiText>
              }
              meta={
                !entry.billable ||
                entry.source === "suggested" ||
                entry.source === "activity"
                  ? [
                      entry.source === "suggested" ||
                      entry.source === "activity"
                        ? tCommon("suggested")
                        : null,
                      entry.billable ? null : tBilling("nonBillable"),
                    ]
                      .filter((label) => label !== null)
                      .join(" · ")
                  : null
              }
              duration={
                <span className="text-muted-foreground">
                  {formatMinutes(entry.durationMinutes)}
                </span>
              }
              trailing={
                entry.status === "draft" && entry.timerStartedAt === null ? (
                  <>
                    {canUpdate && (
                      <Button
                        aria-label={timeEntryActionLabel(
                          tCommon("edit"),
                          entry.narrative,
                        )}
                        className="size-11"
                        onClick={() =>
                          setDialog({ type: "edit", id: entry.id })
                        }
                        size="icon"
                        variant="ghost"
                      >
                        <PencilIcon className="size-4" />
                      </Button>
                    )}
                    {canDelete && (
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
                  </>
                ) : null
              }
            />
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
              onSubmit={submitOnce}
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
                      reportFailure(error, "PersonalTimesheetDay:delete-entry");
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
