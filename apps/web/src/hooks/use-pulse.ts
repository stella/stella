import { useCallback, useEffect, useRef, useState } from "react";

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

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );

  const pulse = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    setIsPulsing(true);
    timerRef.current = window.setTimeout(() => {
      setIsPulsing(false);
      timerRef.current = null;
    }, durationMs);
  }, [durationMs]);

  return { isPulsing, pulse };
};
