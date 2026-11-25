import { useState } from "react";

import { Button } from "@stll/ui/button";

import { useExternalSyncEffect } from "@/hooks/use-effect";

import type { stormWatchBenches } from "../-visual-metadata";

// Two render loops kept on purpose, for the storm watch's own browser test
// (e2e/ui-playground/storm-watch.geometry.spec.ts): one click starts each,
// and nothing outside the page keeps it going. If the watch stops seeing
// them, it has stopped seeing storms.

/** Re-renders itself on every animation frame, as a resize loop does. */
const FrameLoop = () => {
  const [running, setRunning] = useState(false);
  const [frames, setFrames] = useState(0);
  useExternalSyncEffect(() => {
    if (!running) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      setFrames((count) => count + 1);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [running, frames]);
  return (
    <Button onClick={() => setRunning(true)} variant="outline">
      {running ? `Looping (${String(frames)})` : "Start the frame loop"}
    </Button>
  );
};

/** Re-renders itself every 120 ms: under any rate threshold, never quiet. */
const SLOW_LOOP_MS = 120;
const SlowLoop = () => {
  const [running, setRunning] = useState(false);
  const [ticks, setTicks] = useState(0);
  useExternalSyncEffect(() => {
    if (!running) {
      return;
    }
    const timer = setTimeout(() => {
      setTicks((count) => count + 1);
    }, SLOW_LOOP_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [running, ticks]);
  return (
    <Button onClick={() => setRunning(true)} variant="outline">
      {running ? `Looping (${String(ticks)})` : "Start the slow loop"}
    </Button>
  );
};

const BENCH = {
  "frame-loop": <FrameLoop />,
  "slow-loop": <SlowLoop />,
} as const satisfies Record<keyof typeof stormWatchBenches, unknown>;

export const StormWatchPlayground = () => (
  <div className="flex flex-col gap-6 p-4">
    {Object.entries(BENCH).map(([bench, loop]) => (
      <section
        className="bg-card flex w-60 flex-col items-start gap-2 rounded-lg border p-3"
        data-playground-section={`storm-watch:${bench}`}
        key={bench}
      >
        {loop}
      </section>
    ))}
  </div>
);
