import { useEffect, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { PlayIcon, SquareIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";

import { MatterCombobox } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/matter-combobox";
import {
  useStartTimer,
  useStopTimer,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/time-entries";
import { resolvedRateOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/rates";
import { activeTimerOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/time-entries";

type TimerControlsProps = {
  workspaceId: string;
};

const formatElapsed = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};

export const TimerControls = ({ workspaceId }: TimerControlsProps) => {
  const t = useTranslations();
  const [matterId, setMatterId] = useState("");
  const [elapsed, setElapsed] = useState(0);

  const userId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.id,
  });

  const { data: activeTimer } = useQuery(activeTimerOptions(workspaceId));

  const today = new Date().toISOString().split("T")[0] ?? "";
  const { data: resolved } = useQuery(
    resolvedRateOptions(workspaceId, userId, today),
  );

  const startTimer = useStartTimer();
  const stopTimer = useStopTimer();

  const isRunning = activeTimer?.timerStartedAt !== null;

  // Tick the elapsed time every second when timer is running
  useEffect(() => {
    if (!isRunning || !activeTimer?.timerStartedAt) {
      setElapsed(0);
      return undefined;
    }

    const startedAt = new Date(activeTimer.timerStartedAt).getTime();
    const tick = () => setElapsed(Date.now() - startedAt);
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [isRunning, activeTimer?.timerStartedAt]);

  const handleStart = () => {
    if (!matterId) {
      stellaToast.add({
        title: t("billing.matterRequired"),
        type: "error",
      });
      return;
    }

    startTimer.mutate(
      {
        workspaceId,
        matterId,
        timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
        rateAtEntry: resolved?.hourlyRate ?? 0,
        currency: resolved?.currency ?? "USD",
      },
      {
        onError: () => {
          stellaToast.add({
            title: t("billing.failedToStartTimer"),
            type: "error",
          });
        },
      },
    );
  };

  const handleStop = () => {
    stopTimer.mutate(
      { workspaceId },
      {
        onError: () => {
          stellaToast.add({
            title: t("billing.failedToStopTimer"),
            type: "error",
          });
        },
      },
    );
  };

  if (isRunning) {
    return (
      <div className="flex items-center gap-3 rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2">
        <span className="size-2 animate-pulse rounded-full bg-green-500" />
        <span className="text-sm font-medium tabular-nums">
          {formatElapsed(elapsed)}
        </span>
        <span className="text-muted-foreground text-xs">
          {t("billing.timerActive")}
        </span>
        <Button
          className="ms-auto"
          onClick={handleStop}
          size="sm"
          variant="destructive"
        >
          <SquareIcon className="size-3.5" />
          {t("billing.stopTimer")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1">
        <MatterCombobox
          onChange={setMatterId}
          value={matterId}
          workspaceId={workspaceId}
        />
      </div>
      <Button
        disabled={!matterId}
        onClick={handleStart}
        size="sm"
        variant="outline"
      >
        <PlayIcon className="size-3.5" />
        {t("billing.startTimer")}
      </Button>
    </div>
  );
};
