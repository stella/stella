import { useState } from "react";

import { Temporal } from "@stll/time";

import { useExternalSyncEffect } from "@/hooks/use-effect";

/** The longest single timer wait; a longer wait re-arms when it fires. */
const MAX_TIMER_DELAY_MS = 60 * 60 * 1000;

/**
 * Whether the browser's clock has passed `at`; an absent `at` has passed.
 * False on the server and through hydration, so both render alike, then true
 * once the clock passes `at`, without the reader reloading. The clock is read
 * only in the effect, never during render.
 */
export const useTimePassed = (at: Date | undefined): boolean => {
  const atMs = at?.getTime();
  // The `at` the clock was last seen past, so a new `at` starts unpassed.
  const [passedMs, setPassedMs] = useState<number | null>(null);
  // Re-arms a wait longer than one timer allows.
  const [rearms, setRearms] = useState(0);
  useExternalSyncEffect(() => {
    if (atMs === undefined || passedMs === atMs) {
      return undefined;
    }
    const remaining = atMs - Temporal.Now.instant().epochMilliseconds;
    const timer = setTimeout(
      () => {
        if (Temporal.Now.instant().epochMilliseconds >= atMs) {
          setPassedMs(atMs);
        } else {
          setRearms((count) => count + 1);
        }
      },
      Math.max(0, Math.min(MAX_TIMER_DELAY_MS, remaining)),
    );
    return () => clearTimeout(timer);
  }, [atMs, passedMs, rearms]);
  return atMs === undefined || passedMs === atMs;
};
