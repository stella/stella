import { useState } from "react";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { TaggedError } from "better-result";
import { useFormatter, useNow, useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { ClockIcon } from "@stll/ui/icons";
import {
  Popover,
  PopoverPanel,
  PopoverTitle,
  PopoverTrigger,
} from "@stll/ui/popover";

import { useTimerMutation } from "@/features/time-timers/mutations";
import { timeTimersOptions } from "@/features/time-timers/queries";
import { TimerError } from "@/features/time-timers/timer-error";
import { TimerForm } from "@/features/time-timers/timer-form";
import {
  elapsedTimerSeconds,
  formatTimerSeconds,
  runningTimer,
  type TimeTimer,
} from "@/features/time-timers/timer.logic";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { usePermissions } from "@/hooks/use-permissions";
import { useAnalytics } from "@/lib/analytics/provider";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";

type TimerPanelState =
  | { type: "list" }
  | { type: "start" }
  | { type: "confirm"; timer: TimeTimer };

class TimerSnapshotConflictError extends TaggedError(
  "TimerSnapshotConflictError",
)<{
  message: string;
  runningCount: number;
}> {}

export const GlobalTimerContent = ({
  workspaceId,
}: {
  workspaceId?: string;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const user = useAuthenticatedUser();
  const analytics = useAnalytics();
  const now = useNow({ updateInterval: 1000 }).getTime();
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<TimerPanelState>({ type: "list" });
  const timers = useInfiniteQuery(
    timeTimersOptions(user.activeOrganizationId, user.id),
  );
  const matters = useQuery(
    workspacesNavigationOptions({
      organizationId: user.activeOrganizationId,
      userId: user.id,
    }),
  );
  const mutation = useTimerMutation();
  const canCreate = usePermissions({ timeEntry: ["create"] });
  const canUpdate = usePermissions({ timeEntry: ["update"] });
  const canDelete = usePermissions({ timeEntry: ["delete"] });
  const timerItems = timers.data?.pages.flatMap((page) => page.items);
  const active =
    timerItems === undefined ? undefined : runningTimer(timerItems);
  const runningCount =
    timerItems?.filter((timer) => timer.state === "running").length ?? 0;
  useExternalSyncEffect(() => {
    if (runningCount > 1) {
      analytics.captureError(
        new TimerSnapshotConflictError({
          message: "Multiple running timers in paginated snapshot",
          runningCount,
        }),
      );
    }
  }, [analytics, runningCount]);
  const elapsed = (timer: TimeTimer) =>
    formatTimerSeconds({
      seconds: elapsedTimerSeconds(timer, now),
      formatNumber: (value) =>
        format.number(value, { minimumIntegerDigits: 2, useGrouping: false }),
    });
  const selectedMatterId =
    panel.type === "confirm" ? panel.timer.matterId : workspaceId;
  const selectedMatter = matters.data?.workspaces.find(
    (matter) => matter.id === selectedMatterId,
  );
  const initialMatter = selectedMatter
    ? {
        id: selectedMatter.id,
        name: selectedMatter.name,
        clientName: selectedMatter.client?.displayName ?? null,
      }
    : null;

  return (
    <div className="flex items-center">
      <Popover
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          setPanel({ type: "list" });
          mutation.reset();
        }}
      >
        <PopoverTrigger
          render={
            <Button
              className="min-h-11"
              variant="ghost"
              aria-label={t("billing.globalTimer.title")}
            />
          }
        >
          <ClockIcon className="size-4" />
          {active ? (
            <bdi className="text-sm tabular-nums">{elapsed(active)}</bdi>
          ) : (
            <span className="sr-only">{t("billing.globalTimer.title")}</span>
          )}
        </PopoverTrigger>
        <PopoverPanel align="end" className="w-96 max-w-[calc(100vw-2rem)]">
          <PopoverTitle>{t("billing.globalTimer.title")}</PopoverTitle>
          {panel.type === "list" ? (
            <>
              {timers.isPending && (
                <p className="text-muted-foreground text-sm">
                  {t("common.loading")}
                </p>
              )}
              {timers.error !== null && (
                <div className="flex items-center gap-2">
                  <p className="text-destructive text-sm" role="alert">
                    {timers.error.message}
                  </p>
                  <Button
                    onClick={() =>
                      detached(timers.refetch(), "global-timer.retry")
                    }
                    variant="ghost"
                  >
                    {t("common.retry")}
                  </Button>
                </div>
              )}
              {matters.error !== null && (
                <p className="text-destructive text-sm" role="alert">
                  {matters.error.message}
                </p>
              )}
              {timerItems?.map((timer) => {
                const matter = matters.data?.workspaces.find(
                  (item) => item.id === timer.matterId,
                );
                return (
                  <div
                    className="flex flex-col gap-2 border-b pb-3"
                    key={timer.id}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <BidiText className="text-sm">
                          {timer.description ||
                            t("billing.narrativePlaceholder")}
                        </BidiText>
                        {matter && (
                          <BidiText
                            as="p"
                            className="text-muted-foreground text-xs"
                          >
                            {matter.name}
                          </BidiText>
                        )}
                      </div>
                      <bdi className="shrink-0 text-sm tabular-nums">
                        {elapsed(timer)}
                      </bdi>
                    </div>
                    {(canUpdate || canDelete) && (
                      <div className="flex flex-wrap gap-1">
                        {canUpdate && (
                          <Button
                            className="min-h-11"
                            disabled={mutation.isPending}
                            onClick={() =>
                              mutation.mutate({
                                type:
                                  timer.state === "running"
                                    ? "pause"
                                    : "resume",
                                id: timer.id,
                              })
                            }
                            variant="ghost"
                          >
                            {t(
                              timer.state === "running"
                                ? "billing.globalTimer.pause"
                                : "billing.globalTimer.resume",
                            )}
                          </Button>
                        )}
                        {canCreate && canUpdate && (
                          <Button
                            className="min-h-11"
                            disabled={mutation.isPending || matters.isPending}
                            onClick={() => {
                              mutation.reset();
                              setPanel({ type: "confirm", timer });
                            }}
                            variant="outline"
                          >
                            {t("billing.globalTimer.confirm")}
                          </Button>
                        )}
                        {canDelete && (
                          <Button
                            className="min-h-11"
                            disabled={mutation.isPending}
                            onClick={() =>
                              mutation.mutate({ type: "discard", id: timer.id })
                            }
                            variant="ghost"
                          >
                            {t("billing.globalTimer.discard")}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {timers.hasNextPage && (
                <Button
                  disabled={timers.isFetchingNextPage}
                  onClick={() =>
                    detached(timers.fetchNextPage(), "global-timer.load-more")
                  }
                  variant="ghost"
                >
                  {t(
                    timers.isFetchingNextPage
                      ? "common.loading"
                      : "common.loadMore",
                  )}
                </Button>
              )}
              <TimerError error={mutation.error} />
              {canCreate && (
                <Button
                  disabled={
                    mutation.isPending ||
                    (workspaceId !== undefined && matters.isPending)
                  }
                  onClick={() => setPanel({ type: "start" })}
                >
                  {t("billing.startTimer")}
                </Button>
              )}
            </>
          ) : (
            <TimerForm
              key={panel.type === "confirm" ? panel.timer.id : "start"}
              initialMatter={initialMatter}
              timer={panel.type === "confirm" ? panel.timer : null}
              onDone={() => setPanel({ type: "list" })}
            />
          )}
        </PopoverPanel>
      </Popover>
      {active && canUpdate && (
        <Button
          className="min-h-11"
          disabled={mutation.isPending}
          onClick={() => {
            setOpen(true);
            mutation.mutate({ type: "pause", id: active.id });
          }}
          variant="ghost"
        >
          {t("billing.globalTimer.pause")}
        </Button>
      )}
    </div>
  );
};
