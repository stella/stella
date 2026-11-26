import { useState } from "react";

import { useExternalSyncEffect } from "@stll/ui/effects";

import { epochMilliseconds } from "@/connection/clock";

/**
 * The time now, in epoch milliseconds, read again each second while
 * `ticking`, so a running clock on screen counts up; still otherwise.
 */
export const useNow = (ticking: boolean): number => {
  const [now, setNow] = useState(epochMilliseconds);
  useExternalSyncEffect(() => {
    if (!ticking) {
      return undefined;
    }
    const tick = setInterval(() => {
      setNow(epochMilliseconds());
    }, 1000);
    return () => {
      clearInterval(tick);
    };
  }, [ticking]);
  return now;
};
