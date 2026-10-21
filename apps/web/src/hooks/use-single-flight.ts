import { useRef, useState } from "react";

type SingleFlight = {
  /**
   * Run `submit` unless one is already in flight. The guard is set before
   * the first await, so a second click or Enter in the same frame, before a
   * re-render disables the button, is ignored instead of creating twice.
   */
  run: (submit: () => Promise<unknown>) => Promise<void>;
  /**
   * The same guard for a callback-style `mutation.mutate`: `start` receives
   * `settled`, which it passes as the call's `onSettled` (and calls itself
   * on any early return).
   */
  runSettled: (start: (settled: () => void) => void) => Promise<void>;
  /** For the submit control's disabled and loading state. */
  pending: boolean;
};

/** One in-flight submit per form: every create form submits through this. */
export const useSingleFlight = (): SingleFlight => {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);

  const run = async (submit: () => Promise<unknown>) => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setPending(true);
    try {
      await submit();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const runSettled = async (start: (settled: () => void) => void) => {
    await run(async () => {
      const done = Promise.withResolvers<undefined>();
      start(() => done.resolve(undefined));
      await done.promise;
    });
  };

  return { run, runSettled, pending };
};
