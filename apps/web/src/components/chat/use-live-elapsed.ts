import { useState } from "react";

import { Temporal } from "@stll/time";

import {
  advanceToolCallTiming,
  createToolCallTiming,
} from "@/components/chat/tool-call-timing.logic";
import { useExternalSyncEffect } from "@/hooks/use-effect";

const TICK_MS = 1000;

const nowMs = () => Temporal.Now.instant().epochMilliseconds;

/**
 * Milliseconds a piece of work has been running, ticking once a second while
 * it runs and frozen once it stops. `undefined` when this view never saw it
 * run (a reloaded thread): the duration is measured live, not persisted, the
 * same contract as a tool row's elapsed time.
 */
export const useLiveElapsedMs = (isRunning: boolean): number | undefined => {
  const [timing, setTiming] = useState(() =>
    createToolCallTiming({ durationMs: undefined, isRunning, now: nowMs() }),
  );
  const [now, setNow] = useState(nowMs);
  useExternalSyncEffect(() => {
    setTiming((current) =>
      advanceToolCallTiming({
        current,
        durationMs: undefined,
        isRunning,
        now: nowMs(),
      }),
    );
    if (!isRunning) {
      return undefined;
    }
    // The clock is the external system: one tick a second redraws the timer.
    const interval = setInterval(() => {
      setNow(nowMs());
    }, TICK_MS);
    return () => {
      clearInterval(interval);
    };
  }, [isRunning]);

  return timing.status === "running"
    ? Math.max(0, now - timing.startedAt)
    : timing.durationMs;
};
