import { useState } from "react";

import { Temporal } from "@stll/time";

import { useExternalSyncEffect } from "@/hooks/use-effect";

const nowMs = () => Temporal.Now.instant().epochMilliseconds;

/**
 * The latest `value`, but never replaced sooner than `minDwellMs` after the
 * previous one appeared. A burst of quick changes (several tool calls in a
 * second) settles on the newest instead of flashing through each, so a live
 * label stays readable.
 */
export const useSteadyValue = <T>(value: T, minDwellMs: number): T => {
  const [shown, setShown] = useState(() => ({ since: nowMs(), value }));
  useExternalSyncEffect(() => {
    if (Object.is(shown.value, value)) {
      return undefined;
    }
    // The clock is the external system: wait out the current value's dwell.
    const timeout = setTimeout(
      () => {
        setShown({ since: nowMs(), value });
      },
      Math.max(0, shown.since + minDwellMs - nowMs()),
    );
    return () => {
      clearTimeout(timeout);
    };
  }, [minDwellMs, shown, value]);
  return shown.value;
};
