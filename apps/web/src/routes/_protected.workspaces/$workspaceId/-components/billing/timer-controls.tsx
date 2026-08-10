import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { PlayIcon, SquareIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { activeTimerOptions } from "@/lib/workspaces/queries/time-entries";
import { MatterCombobox } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/matter-combobox";
import {
  useStartTimer,
  useStopTimer,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/time-entries";

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
  const [workItemId, setWorkItemId] = useState("");
  const [elapsed, setElapsed] = useState(0);

  const { data: activeTimer } = useQuery(activeTimerOptions(workspaceId));

  const startTimer = useStartTimer();
  const stopTimer = useStopTimer();

  const isRunning = Boolean(activeTimer?.timerStartedAt);

  // Tick the elapsed time every second when timer is running
  useExternalSyncEffect(() => {
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
    if (!workItemId) {
      stellaToast.add({
        title: t("billing.matterRequired"),
        type: "error",
      });
      return;
    }

    startTimer.mutate(
      {
        workspaceId,
        workItemId,
        timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
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
      <div className="border-success/30 bg-success/8 flex items-center gap-3 rounded-md border px-3 py-2">
        <span className="bg-success size-2 animate-pulse rounded-full" />
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
          onChange={setWorkItemId}
          value={workItemId}
          workspaceId={workspaceId}
        />
      </div>
      <Button
        disabled={!workItemId}
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
