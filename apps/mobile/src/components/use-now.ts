import { useEffect, useState } from "react";

import { epochMilliseconds } from "@/connection/clock";

/**
 * The time now, in epoch milliseconds, read again each second while
 * `ticking`, so a running clock on screen counts up; still otherwise.
 */
export const useNow = (ticking: boolean): number => {
  const [now, setNow] = useState(epochMilliseconds);
  useEffect(() => {
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
