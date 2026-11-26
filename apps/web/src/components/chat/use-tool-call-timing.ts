import { useState } from "react";

import { Temporal } from "@stll/time";

import {
  advanceToolCallTiming,
  createToolCallTiming,
} from "@/components/chat/tool-call-timing.logic";
import type { ToolCallTiming } from "@/components/chat/tool-call-timing.logic";

const nowMs = () => Temporal.Now.instant().epochMilliseconds;

/**
 * How long a step ran: the reported `durationMs` when there is one, else the
 * time this page saw it running. The clock is read in the render that sees
 * `isRunning` (or `durationMs`) change, so the stamp lands with the change
 * itself: no effect, and no extra commit.
 */
export const useToolCallTiming = ({
  durationMs,
  isRunning,
}: {
  durationMs: number | undefined;
  isRunning: boolean;
}): ToolCallTiming => {
  const [timing, setTiming] = useState(() =>
    createToolCallTiming({ durationMs, isRunning, now: nowMs() }),
  );
  const [seenIsRunning, setSeenIsRunning] = useState(isRunning);
  const [seenDurationMs, setSeenDurationMs] = useState(durationMs);
  if (seenIsRunning !== isRunning) {
    setSeenIsRunning(isRunning);
    const now = nowMs();
    setTiming((current) =>
      advanceToolCallTiming({ current, durationMs, isRunning, now }),
    );
  }
  if (seenDurationMs !== durationMs) {
    setSeenDurationMs(durationMs);
    const now = nowMs();
    setTiming((current) =>
      advanceToolCallTiming({ current, durationMs, isRunning, now }),
    );
  }
  return timing;
};
