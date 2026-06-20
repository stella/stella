import { useRef, useState } from "react";

import { useMountEffect } from "@/hooks/use-effect";

/**
 * One-shot attention pulse.
 *
 * Returns `isPulsing` (true while the pulse is active) and `pulse()`
 * (call to start a pulse for `durationMs`). Subsequent `pulse()` calls
 * restart the timer rather than stacking. Designed for surfaces that
 * need a brief visual confirmation, e.g. a glow ring on a chip when
 * the user clicks a related affordance.
 */
export const usePulse = (durationMs: number) => {
  const [isPulsing, setIsPulsing] = useState(false);
  const timerRef = useRef<number | null>(null);

  useMountEffect(() => () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
  });

  const pulse = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    setIsPulsing(true);
    timerRef.current = window.setTimeout(() => {
      setIsPulsing(false);
      timerRef.current = null;
    }, durationMs);
  };

  return { isPulsing, pulse };
};
