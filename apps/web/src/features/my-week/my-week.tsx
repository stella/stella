import { useState } from "react";

import {
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import type { TimeSubmitRefusal } from "@stll/api-contract/time-entries";
import { Button } from "@stll/ui/button";
import { Dialog, DialogPanel, DialogPopup, DialogTitle } from "@stll/ui/dialog";
import { ScrollArea } from "@stll/ui/scroll-area";

import {
  ManualTimeEntryForm,
  type ManualTimeEntryValues,
} from "@/components/billing/manual-time-entry-form";
import { type MyTimeEntry, MyWeekDay } from "@/features/my-week/my-week-day";
import { MyWeekHeader } from "@/features/my-week/my-week-header";
import {
  pendingCountByDay,
  shiftWeeks,
  weekOf,
  weekTotals,
} from "@/features/my-week/my-week.logic";
import { PendingApprovalsLink } from "@/features/my-week/pending-approvals-link";
import {
  SUBMIT_REFUSAL_KEYS,
  SubmitWeekActions,
} from "@/features/my-week/submit-week";
import {
  type SuggestionTarget,
  useMyWeekActions,
} from "@/features/my-week/use-my-week-actions";
import { WeekStrip } from "@/features/my-week/week-strip";
import { usePermissions } from "@/hooks/use-permissions";
import { useSingleFlight } from "@/hooks/use-single-flight";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import { myTimeEntriesInfiniteOptions } from "@/lib/workspaces/queries/my-time-entries";
import { myTimeSuggestionsOptions } from "@/lib/workspaces/queries/my-time-suggestions";

type MyWeekProps = {
  organizationId: string;
  userId: string;
  timezoneId: string;
  /** The opened day; its Monday-to-Sunday week is the one shown. */
  date: string;
  onSelectDate: (date: string) => void;
  onToday: () => void;
};

type WeekDialog =
  | { type: "closed" }
  | { type: "edit"; entry: MyTimeEntry }
  | { type: "accept"; target: SuggestionTarget; narrative: string };

/** The queries behind one week, shared by the route loader and the page. */
export const myWeekQueries = ({
  organizationId,
  userId,
  timezoneId,
  date,
}: Pick<MyWeekProps, "organizationId" | "userId" | "timezoneId" | "date">) => {
  const week = weekOf(date);
  const range = { startDate: week.start, endDate: week.end };
  return {
    week,
    entries: myTimeEntriesInfiniteOptions(organizationId, userId, range),
    suggestions: myTimeSuggestionsOptions(organizationId, userId, {
      ...range,
      timezoneId,
    }),
  };
};

const dialogDefaults = (dialog: WeekDialog): ManualTimeEntryValues => {
  switch (dialog.type) {
    case "accept":
      return {
        dateWorked: dialog.target.date,
        durationMinutes: dialog.target.suggestion.durationMinutes,
        narrative: dialog.narrative,
        narrativeLanguage: null,
        billable: dialog.target.suggestion.billableByDefault,
      };
    case "edit":
      return {
        dateWorked: dialog.entry.dateWorked,
        durationMinutes: dialog.entry.durationMinutes,
        narrative: dialog.entry.narrative,
        narrativeLanguage: dialog.entry.narrativeLanguage,
        billable: dialog.entry.billable,
      };
    case "closed":
      return panic("A closed week dialog has no form");
    default:
      dialog satisfies never;
      return panic("Unhandled week dialog state");
  }
};

const dialogMatterId = (dialog: WeekDialog) => {
  switch (dialog.type) {
    case "accept":
      return dialog.target.matter.id;
    case "edit":
      return dialog.entry.workspaceId;
    case "closed":
      return null;
    default:
      dialog satisfies never;
      return panic("Unhandled week dialog state");
  }
};

export const MyWeek = ({
  organizationId,
  userId,
  timezoneId,
  date,
  onSelectDate,
  onToday,
}: MyWeekProps) => {
  const t = useTranslations();
  const tBilling = useTranslations("billing");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const queries = myWeekQueries({ organizationId, userId, timezoneId, date });
  const { week } = queries;
  const entriesQuery = useSuspenseInfiniteQuery(queries.entries);
  const { data: suggestionRange } = useSuspenseQuery(queries.suggestions);
  const canDecide = usePermissions({ timeEntry: ["create"] });
  const canEdit = usePermissions({ timeEntry: ["update"] });
  const canApprove = usePermissions({ timeEntry: ["approve"] });
  const actions = useMyWeekActions({ organizationId, timezoneId });
  const submitGuard = useSingleFlight();
  const [dialog, setDialog] = useState<WeekDialog>({ type: "closed" });
  const [refusals, setRefusals] = useState<
    ReadonlyMap<string, TimeSubmitRefusal>
  >(() => new Map());

  const pages = entriesQuery.data.pages;
  // Every page carries the totals for the whole week; the first is enough.
  const firstPage = pages.at(0);
  const totals = weekTotals(firstPage === undefined ? [] : firstPage.days);
  const entries = pages
    .flatMap((page) => page.items)
    .filter((entry) => entry.dateWorked === date);
  const loggedMinutes = totals.byDay.get(date) ?? 0;
  // The week's entries are paged, and any page may hold the day's entries
  // (running timers count zero minutes), so no day is empty until all load.
  const entriesComplete = !entriesQuery.hasNextPage;
  const suggestionDay = suggestionRange.days.find((day) => day.date === date);
  const suggestions = suggestionDay === undefined ? [] : suggestionDay.matters;
  const matterId = dialogMatterId(dialog);
  // Submission covers the whole week, so drafts on pages not loaded yet count:
  // with a page left, the week may still hold some.
  const canSubmitWeek =
    entriesQuery.hasNextPage ||
    pages
      .flatMap((page) => page.items)
      .some((entry) => entry.status === "draft");
  const refusalNotes = new Map(
    [...refusals].map(([id, reason]) => [id, t(SUBMIT_REFUSAL_KEYS[reason])]),
  );

  const submitDialog = async (values: ManualTimeEntryValues) => {
    await submitGuard.run(async () => {
      const saved = await Result.tryPromise({
        try: async () => {
          if (dialog.type === "accept") {
            await actions.accept(dialog.target, values);
          } else if (dialog.type === "edit") {
            await actions.editEntry(dialog.entry, values);
          }
        },
        catch: (cause: unknown): unknown => cause,
      });
      if (Result.isError(saved)) {
        actions.reportFailure(saved.error);
        return;
      }
      setDialog({ type: "closed" });
    });
  };

  return (
    <div className="flex h-full flex-col">
      <MyWeekHeader
        actions={
          <>
            {canApprove && (
              <PendingApprovalsLink
                organizationId={organizationId}
                userId={userId}
              />
            )}
            <SubmitWeekActions
              canApproveOwn={canApprove}
              canSubmit={canSubmitWeek}
              onRefusals={setRefusals}
              submit={actions.submitWeek}
              submitting={actions.submitting}
              week={week}
            />
          </>
        }
        onNextWeek={() => onSelectDate(shiftWeeks(date, 1))}
        onPreviousWeek={() => onSelectDate(shiftWeeks(date, -1))}
        onToday={onToday}
        totals={totals}
        week={week}
      />
      <WeekStrip
        onSelectDate={onSelectDate}
        pendingByDay={pendingCountByDay(suggestionRange.days)}
        selectedDate={date}
        totals={totals}
        week={week}
      />
      <ScrollArea className="min-h-0 flex-1">
        <MyWeekDay
          busyFingerprints={actions.busyFingerprints}
          canDecide={canDecide}
          canEdit={canEdit}
          notes={refusalNotes}
          date={date}
          entries={entries}
          entriesComplete={entriesComplete}
          loggedMinutes={loggedMinutes}
          onAccept={(matter, suggestion, narrative) =>
            detached(
              actions.fromRow(
                actions.accept(
                  { matter, date, suggestion },
                  {
                    durationMinutes: suggestion.durationMinutes,
                    narrative,
                    narrativeLanguage: null,
                    billable: suggestion.billableByDefault,
                  },
                ),
              ),
              "my-week.accept-suggestion",
            )
          }
          onDismiss={(matter, suggestion) =>
            detached(
              actions.fromRow(actions.dismiss({ matter, date, suggestion })),
              "my-week.dismiss-suggestion",
            )
          }
          onEdit={(matter, suggestion, narrative) =>
            setDialog({
              type: "accept",
              target: { matter, date, suggestion },
              narrative,
            })
          }
          onEditEntry={(entry) => setDialog({ type: "edit", entry })}
          suggestions={suggestions}
        />
        {entriesQuery.hasNextPage && (
          <div className="flex justify-center pb-4">
            <Button
              disabled={entriesQuery.isFetchingNextPage}
              onClick={() =>
                detached(
                  (async () => {
                    const page = await entriesQuery.fetchNextPage();
                    // Loaded entries stay; the failure is said, and the
                    // button stays to retry.
                    if (page.isFetchNextPageError) {
                      notifyUserError(page.error, tErrors("actionFailed"));
                    }
                  })(),
                  "my-week.next-page",
                )
              }
              size="sm"
              variant="outline"
            >
              {tCommon("loadMore")}
            </Button>
          </div>
        )}
      </ScrollArea>
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
                : tBilling("suggestions.title")}
            </DialogTitle>
            {matterId !== null && (
              <ManualTimeEntryForm
                dateLocked={dialog.type === "accept"}
                defaultValues={dialogDefaults(dialog)}
                onCancel={() => setDialog({ type: "closed" })}
                onSubmit={submitDialog}
                pending={actions.pending || submitGuard.pending}
                workspaceId={matterId}
              />
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
};
