import { type ReactElement, useState } from "react";

import { Button } from "@stll/ui/button";

import { useExternalSyncEffect } from "@/hooks/use-effect";

import type { stormWatchBenches } from "../-visual-metadata";

// Two render loops kept on purpose, for the storm watch's own browser test
// (e2e/ui-playground/storm-watch.geometry.spec.ts): one click starts each,
// and nothing outside the page keeps it going. If the watch stops seeing
// them, it has stopped seeing storms.

/** Re-renders itself on every animation frame, as a resize loop does. */
const FrameLoop = () => {
  const [frames, setFrames] = useState(0);
  useExternalSyncEffect(() => {
    const frame = requestAnimationFrame(() => {
      setFrames((count) => count + 1);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [frames]);
  return <span>{`Looping (${String(frames)})`}</span>;
};

/** Re-renders itself every 120 ms: under any rate threshold, never quiet. */
const SLOW_LOOP_MS = 120;
const SlowLoop = () => {
  const [ticks, setTicks] = useState(0);
  useExternalSyncEffect(() => {
    const timer = setTimeout(() => {
      setTicks((count) => count + 1);
    }, SLOW_LOOP_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [ticks]);
  return <span>{`Looping (${String(ticks)})`}</span>;
};

/** One click starts the loop; nothing outside the page feeds it after. */
const StartOnClick = ({
  label,
  loop,
}: {
  label: string;
  loop: ReactElement;
}) => {
  const [running, setRunning] = useState(false);
  return running ? (
    loop
  ) : (
    <Button onClick={() => setRunning(true)} variant="outline">
      {label}
    </Button>
  );
};

const BENCH = {
  "frame-loop": (
    <StartOnClick label="Start the frame loop" loop={<FrameLoop />} />
  ),
  "slow-loop": <StartOnClick label="Start the slow loop" loop={<SlowLoop />} />,
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
